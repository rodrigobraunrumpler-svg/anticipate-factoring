import type { ApiErrorCode } from '@anticipate/shared/api'

/** Código público de cada estado HTTP de las excepciones de Nest, del router y de middlewares. */
export const DEFAULT_HTTP_ERROR_CODE: ReadonlyMap<number, ApiErrorCode> = new Map<
  number,
  ApiErrorCode
>([
  [400, 'BAD_REQUEST'],
  [404, 'RESOURCE_NOT_FOUND'],
  [409, 'CONFLICT'],
  [411, 'LENGTH_REQUIRED'],
  [413, 'PAYLOAD_TOO_LARGE'],
  [429, 'RATE_LIMIT_EXCEEDED'],
  [503, 'SERVICE_UNAVAILABLE'],
])

/** Código para un estado sin entrada propia: cualquier otro 4xx es `BAD_REQUEST`; el resto, `INTERNAL_ERROR`. */
export function defaultHttpErrorCode(status: number): ApiErrorCode {
  const code = DEFAULT_HTTP_ERROR_CODE.get(status)
  if (code !== undefined) return code
  return status >= 400 && status < 500 ? 'BAD_REQUEST' : 'INTERNAL_ERROR'
}
