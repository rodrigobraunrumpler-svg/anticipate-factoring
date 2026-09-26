import {
  API_ERROR_HTTP_STATUS,
  API_ERROR_MESSAGES_ES,
  type ApiErrorCode,
  type ApiErrorEnvelope,
} from '@anticipate/shared/api'
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Inject,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common'
import { ThrottlerException } from '@nestjs/throttler'
import type { Request, Response } from 'express'
import { CORRELATION_ID_HEADER } from '#/common/constants/http-headers.constants.js'
import {
  ApiValidationError,
  BusinessRulesViolatedError,
  isApplicationError,
  normalizeViolations,
} from '#/common/exceptions/index.js'
import { resolveCorrelationId } from '#/common/utils/correlation-id.js'
import { defaultHttpErrorCode } from './default-http-error-code.map.js'
import { EXCEPTION_TRANSLATORS, type ExceptionTranslator } from './exception-translator.js'

/** Rutas de salud (fuera del prefijo `api`): cuando fallan, responden con el cuerpo de Terminus. */
const HEALTH_PATH = /^\/health(?:\/|$)/

type PublicError = {
  readonly code: ApiErrorCode
  readonly message: string
  readonly details?: NonNullable<ApiErrorEnvelope['details']>
}

/** Forma de los errores de `http-errors` que lanza body-parser: no son `HttpException` de Nest. */
type HttpErrorLike = { readonly status: number; readonly type: string | undefined }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asHttpErrorLike(exception: unknown): HttpErrorLike | undefined {
  if (!isRecord(exception) || exception instanceof HttpException) return undefined
  const status = typeof exception.status === 'number' ? exception.status : exception.statusCode
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 599) {
    return undefined
  }
  return { status, type: typeof exception.type === 'string' ? exception.type : undefined }
}

/** Cuerpo de Terminus de un chequeo de salud fallido (`status` error o shutting_down). */
function terminusBody(exception: unknown, request: Request): Record<string, unknown> | undefined {
  if (!(exception instanceof ServiceUnavailableException)) return undefined
  if ((request.method !== 'GET' && request.method !== 'HEAD') || !HEALTH_PATH.test(request.path)) {
    return undefined
  }
  const body = exception.getResponse()
  if (!isRecord(body) || (body.status !== 'error' && body.status !== 'shutting_down')) {
    return undefined
  }
  const allowed = new Set(['status', 'info', 'error', 'details'])
  const shapeIsTerminus =
    Object.keys(body).every((key) => allowed.has(key)) &&
    isRecord(body.details) &&
    (body.info === undefined || isRecord(body.info)) &&
    (body.error === undefined || isRecord(body.error))
  return shapeIsTerminus ? body : undefined
}

function publicErrorOf(exception: unknown): PublicError {
  if (isApplicationError(exception)) {
    const { publicCode: code, publicMessage: message } = exception
    if (code === 'VALIDATION_ERROR') {
      // Solo `ApiValidationError` trae observaciones; otra clase con este código recibe la genérica.
      const violations =
        exception instanceof ApiValidationError ? exception.violations : normalizeViolations([])
      return { code, message, details: { violations: [...violations] } }
    }
    if (code === 'BUSINESS_RULES_VIOLATED') {
      if (exception instanceof BusinessRulesViolatedError) {
        return { code, message, details: { problems: [...exception.problems] } }
      }
      // Sin problemas no hay 422 que responder: es un defecto del código.
      return { code: 'INTERNAL_ERROR', message: API_ERROR_MESSAGES_ES.INTERNAL_ERROR }
    }
    return { code, message }
  }
  const code = codeOf(exception)
  return { code, message: API_ERROR_MESSAGES_ES[code] }
}

function codeOf(exception: unknown): ApiErrorCode {
  if (exception instanceof ThrottlerException) return 'RATE_LIMIT_EXCEEDED'
  if (exception instanceof HttpException) return defaultHttpErrorCode(exception.getStatus())
  const httpError = asHttpErrorLike(exception)
  if (httpError !== undefined) {
    if (httpError.type === 'entity.parse.failed') return 'MALFORMED_JSON'
    return defaultHttpErrorCode(httpError.status)
  }
  return 'INTERNAL_ERROR'
}

/**
 * Único punto donde un error se convierte en respuesta HTTP. Todo error sale con el sobre de
 * `@anticipate/shared/api`, un código de `API_ERROR_CODES`, el estado HTTP de ese código y un mensaje
 * en español: el de la `ApplicationError` o el de `API_ERROR_MESSAGES_ES`. Nunca reenvía el mensaje
 * de una `HttpException` ni de una librería (Nest, body-parser, multer, throttler). La única excepción
 * al sobre es un chequeo de salud fallido, que responde 503 con el cuerpo de Terminus.
 *
 * Un error de una librería de infraestructura pasa antes por los `EXCEPTION_TRANSLATORS`: así la base
 * caída es 503 `SERVICE_UNAVAILABLE` en cualquier ruta, sin que cada caso de uso la envuelva. El log
 * registra el error original (su clase y su código), no el traducido.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name)

  constructor(
    @Optional()
    @Inject(EXCEPTION_TRANSLATORS)
    private readonly translators: readonly ExceptionTranslator[] = [],
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp()
    const request = http.getRequest<Request>()
    const response = http.getResponse<Response>()
    const correlationId = request.correlationId ?? resolveCorrelationId(request)

    if (response.headersSent) {
      // La respuesta ya empezó: no se puede cambiar el estado. Se corta la conexión para que el
      // cliente no tome como completa una respuesta truncada.
      this.logger.error(
        { err: exception, correlationId },
        'Error después de empezar a enviar la respuesta; se cierra la conexión',
      )
      response.destroy()
      return
    }
    response.setHeader(CORRELATION_ID_HEADER, correlationId)

    const health = terminusBody(exception, request)
    if (health !== undefined) {
      response.status(503).json(health)
      return
    }

    const error = publicErrorOf(this.translate(exception))
    const statusCode = API_ERROR_HTTP_STATUS[error.code]
    if (statusCode >= 500) {
      this.logger.error(
        { err: exception, code: error.code, statusCode, correlationId },
        `Respuesta ${statusCode} ${error.code}`,
      )
    }
    const body: ApiErrorEnvelope = {
      success: false,
      statusCode,
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
      correlationId,
      timestamp: new Date().toISOString(),
    }
    response.status(statusCode).json(body)
  }

  /** El error del primer traductor que lo reconoce, o el mismo si ninguno lo hace. */
  private translate(exception: unknown): unknown {
    if (isApplicationError(exception) || exception instanceof HttpException) return exception
    for (const translator of this.translators) {
      try {
        const translated = translator(exception)
        if (translated !== undefined) return translated
      } catch {
        // Un traductor roto no puede impedir la respuesta: el error sigue con los demás.
      }
    }
    return exception
  }
}
