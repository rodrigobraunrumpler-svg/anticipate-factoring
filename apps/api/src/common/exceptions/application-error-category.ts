import { API_ERROR_HTTP_STATUS, type ApiErrorCode } from '@anticipate/shared/api'

/**
 * Categorías estables e independientes del transporte con que la API clasifica sus errores públicos
 * (logs y métricas). No se eligen a mano: salen del estado HTTP de cada código en
 * `API_ERROR_HTTP_STATUS`, que es la única fuente de verdad del estado.
 */
export const ApplicationErrorCategory = {
  BAD_REQUEST: 'BAD_REQUEST',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  LENGTH_REQUIRED: 'LENGTH_REQUIRED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNPROCESSABLE_ENTITY: 'UNPROCESSABLE_ENTITY',
  RATE_LIMIT: 'RATE_LIMIT',
  INTERNAL: 'INTERNAL',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const

export type ApplicationErrorCategory =
  (typeof ApplicationErrorCategory)[keyof typeof ApplicationErrorCategory]

const CATEGORY_BY_HTTP_STATUS: ReadonlyMap<number, ApplicationErrorCategory> = new Map([
  [400, ApplicationErrorCategory.BAD_REQUEST],
  [403, ApplicationErrorCategory.FORBIDDEN],
  [404, ApplicationErrorCategory.NOT_FOUND],
  [409, ApplicationErrorCategory.CONFLICT],
  [411, ApplicationErrorCategory.LENGTH_REQUIRED],
  [413, ApplicationErrorCategory.PAYLOAD_TOO_LARGE],
  [422, ApplicationErrorCategory.UNPROCESSABLE_ENTITY],
  [429, ApplicationErrorCategory.RATE_LIMIT],
  [500, ApplicationErrorCategory.INTERNAL],
  [503, ApplicationErrorCategory.SERVICE_UNAVAILABLE],
])

/**
 * Categoría de un código de error. Un código cuyo estado no tiene categoría es un error de
 * programación: lo detecta el test que recorre `API_ERROR_CODES`.
 */
export function applicationErrorCategoryOf(code: ApiErrorCode): ApplicationErrorCategory {
  const status = API_ERROR_HTTP_STATUS[code]
  const category = CATEGORY_BY_HTTP_STATUS.get(status)
  if (category === undefined) {
    throw new TypeError(
      `El código ${code} responde ${status}, que no tiene categoría: agrégalo a CATEGORY_BY_HTTP_STATUS`,
    )
  }
  return category
}
