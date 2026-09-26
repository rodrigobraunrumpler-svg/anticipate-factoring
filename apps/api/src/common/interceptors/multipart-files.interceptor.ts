import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  mixin,
  type NestInterceptor,
  type Type,
} from '@nestjs/common'
import type { Request, RequestHandler, Response } from 'express'
import multer from 'multer'
import { finalize, type Observable } from 'rxjs'
import { APP_CONFIG, type AppConfig } from '#/common/config/index.js'
import { type ApiError, apiError } from '#/common/exceptions/index.js'
import { declaredContentLength } from '#/common/utils/content-length.js'
import { INFLIGHT_BODY_BUDGET, type InflightBodyBudget } from './inflight-body-budget.js'

/** Segundos que se piden esperar cuando el presupuesto de cuerpos en memoria está lleno. */
export const INFLIGHT_BODY_RETRY_AFTER_SECONDS = 30

/** Un campo de archivos permitido y cuántos archivos acepta. */
export type MultipartFileField = { readonly name: string; readonly maxCount: number }

/** Topes del multipart. Todos obligatorios: ningún envío se lee sin límite. */
export type MultipartLimits = {
  /** Archivos en total. Si llegan más: 400 `TOO_MANY_FILES`. */
  readonly files: number
  /** Bytes por archivo. Es un respaldo (413): los topes por tipo los revisa quien recibe los archivos. */
  readonly fileSize: number
  /** Partes en total (campos de texto más archivos). Si llegan más: 400 `TOO_MANY_FILES`. */
  readonly parts: number
  /** Campos de texto. Si llegan más: 400 `MALFORMED_MULTIPART`. */
  readonly fields: number
  /** Bytes por campo de texto. Si alguno es más largo: 400 `MALFORMED_MULTIPART`. */
  readonly fieldSize: number
}

/** Calcula los topes a partir de la configuración validada (se evalúa una vez, al crear el interceptor). */
export type MultipartLimitsFactory = (config: AppConfig) => MultipartLimits

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(
      `El tope ${name} del multipart debe ser un entero mayor que cero; llegó ${value}`,
    )
  }
}

function checkedFields(fields: readonly MultipartFileField[]): multer.Field[] {
  if (fields.length === 0) {
    throw new TypeError('MultipartFilesInterceptor necesita al menos un campo')
  }
  const names = new Set<string>()
  return fields.map(({ name, maxCount }) => {
    if (name.trim() === '' || names.has(name)) {
      throw new TypeError(`Campo de archivos vacío o repetido: "${name}"`)
    }
    names.add(name)
    assertPositiveInteger(`maxCount de ${name}`, maxCount)
    return { name, maxCount }
  })
}

function checkedLimits(limits: MultipartLimits): MultipartLimits {
  for (const key of ['files', 'fileSize', 'parts', 'fields', 'fieldSize'] as const) {
    assertPositiveInteger(key, limits[key])
  }
  return { ...limits }
}

/**
 * Traduce un error de multer o de busboy a un error público por `MulterError.code`, nunca por su
 * mensaje en inglés: `LIMIT_FILE_COUNT` y `LIMIT_PART_COUNT` → `TOO_MANY_FILES`,
 * `LIMIT_UNEXPECTED_FILE` → `UNEXPECTED_FILE_FIELD`, `LIMIT_FILE_SIZE` → `PAYLOAD_TOO_LARGE` y
 * cualquier otro (límites de campos, nombres inválidos, cuerpo cortado o mal armado) →
 * `MALFORMED_MULTIPART`. Nunca produce un 500. El diagnóstico lleva solo el código: nunca nombres de
 * campos ni de archivos, que manda el cliente.
 */
export function multipartErrorToApiError(error: unknown): ApiError {
  if (error instanceof multer.MulterError) {
    const code: string = error.code
    const diagnostic = `multer: ${code}`
    switch (code) {
      case 'LIMIT_FILE_COUNT':
      case 'LIMIT_PART_COUNT':
        return apiError('TOO_MANY_FILES', diagnostic)
      case 'LIMIT_UNEXPECTED_FILE':
        return apiError('UNEXPECTED_FILE_FIELD', diagnostic)
      case 'LIMIT_FILE_SIZE':
        return apiError('PAYLOAD_TOO_LARGE', diagnostic)
      default:
        return apiError('MALFORMED_MULTIPART', diagnostic)
    }
  }
  return apiError('MALFORMED_MULTIPART', 'multipart ilegible')
}

/**
 * Lee un `multipart/form-data` con multer en memoria (solo los campos de archivos de `fields`,
 * nombres de archivo en UTF-8) y deja los archivos en `request.files` y los campos de texto en
 * `request.body`. Una solicitud que no es multipart recibe 400 `MALFORMED_MULTIPART`.
 *
 * Antes de leer, reserva el `Content-Length` en el presupuesto de cuerpos en memoria del proceso
 * (`INFLIGHT_BODY_BUDGET`, `UPLOAD_MAX_INFLIGHT_BYTES`): sin tamaño declarado, 411
 * `LENGTH_REQUIRED`; si no cabe, 503 `SERVICE_UNAVAILABLE` con `Retry-After`, sin leer un byte. La
 * reserva dura mientras los archivos siguen en memoria: hasta que termina el caso de uso (o antes, si
 * la lectura falla o el cliente corta a mitad del cuerpo).
 */
export function MultipartFilesInterceptor(
  fields: readonly MultipartFileField[],
  limitsFrom: MultipartLimitsFactory,
): Type<NestInterceptor> {
  const multerFields = checkedFields(fields)

  @Injectable()
  class MultipartFilesMixinInterceptor implements NestInterceptor {
    private readonly readMultipart: RequestHandler
    private readonly logger = new Logger('MultipartFilesInterceptor')

    constructor(
      @Inject(APP_CONFIG) config: AppConfig,
      @Inject(INFLIGHT_BODY_BUDGET) private readonly budget: InflightBodyBudget,
    ) {
      this.readMultipart = multer({
        storage: multer.memoryStorage(),
        limits: checkedLimits(limitsFrom(config)),
        defParamCharset: 'utf8',
      }).fields(multerFields)
    }

    async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
      const http = context.switchToHttp()
      const request = http.getRequest<Request>()
      const response = http.getResponse<Response>()
      if (!request.is('multipart/form-data')) {
        throw apiError('MALFORMED_MULTIPART', 'la solicitud no es multipart/form-data')
      }
      // Si el cliente cortó mientras corrían los guards (el del captcha espera a Cloudflare), sus
      // 'close' ya pasaron: el respaldo de abajo nunca correría y multer esperaría para siempre un
      // cuerpo que no llega, con la reserva tomada. Se corta aquí, sin reservar ni leer. Entre esta
      // comprobación y el registro del respaldo no corre nada asíncrono.
      if (request.destroyed || request.socket.destroyed || response.destroyed) {
        throw apiError(
          'MALFORMED_MULTIPART',
          'el cliente cerró la conexión antes de enviar el cuerpo',
        )
      }
      const release = this.reserve(request, response)
      let reading = true
      // Respaldo: si la conexión se cierra durante la lectura, la reserva se libera aunque multer no
      // avise. Después de leer, la libera el fin del caso de uso, que es cuando se sueltan los archivos.
      response.once('close', () => {
        if (reading) release()
      })
      try {
        await new Promise<void>((resolve, reject) => {
          this.readMultipart(request, response, (error?: unknown) => {
            if (error === undefined || error === null) resolve()
            else reject(multipartErrorToApiError(error))
          })
        })
      } catch (error) {
        release()
        throw error
      } finally {
        reading = false
      }
      return next.handle().pipe(finalize(release))
    }

    /** Reserva el `Content-Length` o responde 411 (sin tamaño) o 503 (no cabe). */
    private reserve(request: Request, response: Response): () => void {
      const declared = declaredContentLength(request)
      if (declared === null) {
        throw apiError('LENGTH_REQUIRED', 'multipart sin Content-Length válido')
      }
      const release = this.budget.tryReserve(declared)
      if (release !== null) return release
      this.logger.warn(
        {
          declaredBytes: declared,
          reservedBytes: this.budget.reservedBytes,
          maxInflightBytes: this.budget.maxBytes,
        },
        'Presupuesto de cuerpos en memoria lleno (UPLOAD_MAX_INFLIGHT_BYTES): el envío recibe 503 sin leerse',
      )
      response.setHeader('Retry-After', String(INFLIGHT_BODY_RETRY_AFTER_SECONDS))
      throw apiError(
        'SERVICE_UNAVAILABLE',
        'presupuesto de cuerpos en memoria lleno (UPLOAD_MAX_INFLIGHT_BYTES)',
      )
    }
  }

  return mixin(MultipartFilesMixinInterceptor)
}
