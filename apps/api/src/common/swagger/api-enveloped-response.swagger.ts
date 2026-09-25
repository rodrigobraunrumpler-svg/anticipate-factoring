import { apiSuccessEnvelopeSchema, DEFAULT_SUCCESS_MESSAGE } from '@anticipate/shared/api'
import { ApiResponse } from '@nestjs/swagger'
import { CORRELATION_ID_HEADER } from '#/common/constants/http-headers.constants.js'

/** Esquema Zod de `data` (el mismo que acepta `apiSuccessEnvelopeSchema` de `shared`). */
export type EnvelopeDataSchema = Parameters<typeof apiSuccessEnvelopeSchema>[0]

/** Cabecera `x-correlation-id`, presente en toda respuesta (éxito, error y salud). */
export const CORRELATION_ID_RESPONSE_HEADER = {
  [CORRELATION_ID_HEADER]: {
    description:
      'Id de correlación de la solicitud: el recibido en la cabecera si es válido, o uno nuevo. Es el mismo `correlationId` del cuerpo.',
    schema: { type: 'string', example: '5f0c2a9e-8f3b-4c1d-9a51-2b7e4d6c8a10' },
  },
} as const

export type ApiEnvelopedResponseOptions = {
  /** Estado HTTP del éxito. Por defecto, 200. */
  readonly status?: number
  readonly description: string
  /** Esquema de `data`: para una lista, el esquema del arreglo. */
  readonly data: EnvelopeDataSchema
  /** Mensaje del sobre, si la ruta usa `@ResponseMessage()`. Por defecto, `DEFAULT_SUCCESS_MESSAGE`. */
  readonly message?: string
  /** `page` si la ruta devuelve `PaginatedList`; `cursor` si devuelve `CursorPaginatedList`. */
  readonly pagination?: 'page' | 'cursor'
}

const PAGINATION_NOTE = {
  page: ' Incluye `metadataPagination`.',
  cursor: ' Incluye `metadataCursor`.',
} as const

/**
 * Documenta la respuesta exitosa con el sobre de `@anticipate/shared/api`. El esquema es el mismo
 * `apiSuccessEnvelopeSchema` que valida los tests, así la documentación no se separa del contrato.
 */
export function ApiEnvelopedResponse(options: ApiEnvelopedResponseOptions) {
  const message = options.message ?? DEFAULT_SUCCESS_MESSAGE
  const note = options.pagination === undefined ? '' : PAGINATION_NOTE[options.pagination]
  return ApiResponse({
    status: options.status ?? 200,
    description: `${options.description} Mensaje: «${message}».${note}`,
    standardSchema: apiSuccessEnvelopeSchema(options.data),
    headers: CORRELATION_ID_RESPONSE_HEADER,
  })
}
