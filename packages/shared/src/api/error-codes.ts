import { API_MESSAGES_ES } from '../errors/index.js'

/**
 * Códigos estables del sobre de error de la API (`code`). La landing y el admin deciden qué hacer con
 * el código, nunca con el texto; los tests de la API comparan el código.
 */
export const API_ERROR_CODES = [
  'BAD_REQUEST',
  'VALIDATION_ERROR',
  'MALFORMED_JSON',
  'MALFORMED_MULTIPART',
  'TOO_MANY_FILES',
  'UNEXPECTED_FILE_FIELD',
  'IDEMPOTENCY_KEY_INVALID',
  'CAPTCHA_FAILED',
  'RESOURCE_NOT_FOUND',
  'CONFLICT',
  'LENGTH_REQUIRED',
  'PAYLOAD_TOO_LARGE',
  'BUSINESS_RULES_VIOLATED',
  'IDEMPOTENCY_KEY_REUSED',
  'RATE_LIMIT_EXCEEDED',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
  'CAPTCHA_UNAVAILABLE',
] as const
export type ApiErrorCode = (typeof API_ERROR_CODES)[number]

/** Estados HTTP propios de los códigos de error: uno por categoría de `ApplicationError` en la API. */
export const API_ERROR_HTTP_STATUSES = [400, 403, 404, 409, 411, 413, 422, 429, 500, 503] as const
export type ApiErrorHttpStatus = (typeof API_ERROR_HTTP_STATUSES)[number]

/** Estado HTTP de cada código. La categoría del error en la API se deriva de aquí. */
export const API_ERROR_HTTP_STATUS: Readonly<Record<ApiErrorCode, ApiErrorHttpStatus>> = {
  BAD_REQUEST: 400,
  VALIDATION_ERROR: 400,
  MALFORMED_JSON: 400,
  MALFORMED_MULTIPART: 400,
  TOO_MANY_FILES: 400,
  UNEXPECTED_FILE_FIELD: 400,
  IDEMPOTENCY_KEY_INVALID: 400,
  CAPTCHA_FAILED: 403,
  RESOURCE_NOT_FOUND: 404,
  CONFLICT: 409,
  LENGTH_REQUIRED: 411,
  PAYLOAD_TOO_LARGE: 413,
  BUSINESS_RULES_VIOLATED: 422,
  IDEMPOTENCY_KEY_REUSED: 422,
  RATE_LIMIT_EXCEEDED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
  CAPTCHA_UNAVAILABLE: 503,
}

/**
 * Mensaje para personas de cada código (el `message` del sobre de error). El texto vive en `errors`
 * (`API_MESSAGES_ES.errors`); la anotación exige uno por código y `error-codes.test.ts` que no sobre
 * ninguno.
 */
export const API_ERROR_MESSAGES_ES: Readonly<Record<ApiErrorCode, string>> = API_MESSAGES_ES.errors

/** `code` puede venir de afuera (una respuesta leída por un cliente): nunca se indexa sin comprobarlo. */
export function isApiErrorCode(value: string): value is ApiErrorCode {
  return (API_ERROR_CODES as readonly string[]).includes(value)
}
