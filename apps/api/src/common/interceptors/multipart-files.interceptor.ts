import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  mixin,
  type NestInterceptor,
  type Type,
} from '@nestjs/common'
import type { Request, RequestHandler, Response } from 'express'
import multer from 'multer'
import type { Observable } from 'rxjs'
import { APP_CONFIG, type AppConfig } from '#/common/config/index.js'
import { type ApiError, apiError } from '#/common/exceptions/index.js'

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
 */
export function MultipartFilesInterceptor(
  fields: readonly MultipartFileField[],
  limitsFrom: MultipartLimitsFactory,
): Type<NestInterceptor> {
  const multerFields = checkedFields(fields)

  @Injectable()
  class MultipartFilesMixinInterceptor implements NestInterceptor {
    private readonly readMultipart: RequestHandler

    constructor(@Inject(APP_CONFIG) config: AppConfig) {
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
      await new Promise<void>((resolve, reject) => {
        this.readMultipart(request, response, (error?: unknown) => {
          if (error === undefined || error === null) resolve()
          else reject(multipartErrorToApiError(error))
        })
      })
      return next.handle()
    }
  }

  return mixin(MultipartFilesMixinInterceptor)
}
