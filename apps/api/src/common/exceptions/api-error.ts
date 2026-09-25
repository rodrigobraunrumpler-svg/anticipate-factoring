import type { ApiErrorCode } from '@anticipate/shared/api'
import { ApplicationError } from './application-error.js'

/** Códigos que siempre llevan detalle y tienen su propia clase. */
export type DetailedApiErrorCode = 'VALIDATION_ERROR' | 'BUSINESS_RULES_VIOLATED'

/** Códigos que se lanzan sin detalle, con `apiError(code)`. */
export type PlainApiErrorCode = Exclude<ApiErrorCode, DetailedApiErrorCode>

const DETAILED_API_ERROR_CODES: ReadonlySet<string> = new Set<DetailedApiErrorCode>([
  'VALIDATION_ERROR',
  'BUSINESS_RULES_VIOLATED',
])

export type ApiErrorOptions = { readonly cause?: unknown }

/** Error público sin detalle: el código decide el estado HTTP y el mensaje en español. */
export class ApiError<
  TCode extends PlainApiErrorCode = PlainApiErrorCode,
> extends ApplicationError<TCode> {
  constructor(code: TCode, diagnostic?: string, options: ApiErrorOptions = {}) {
    if (DETAILED_API_ERROR_CODES.has(code)) {
      throw new TypeError(
        `${code} lleva detalle: usa ApiValidationError o BusinessRulesViolatedError`,
      )
    }
    super(code, { diagnostic, cause: options.cause })
  }
}

/**
 * `throw apiError('CAPTCHA_FAILED')`. El diagnóstico es privado: va a los logs, nunca a la
 * respuesta.
 */
export function apiError<TCode extends PlainApiErrorCode>(
  code: TCode,
  diagnostic?: string,
  options?: ApiErrorOptions,
): ApiError<TCode> {
  return new ApiError(code, diagnostic, options)
}
