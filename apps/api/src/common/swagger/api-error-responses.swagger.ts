import {
  API_ERROR_HTTP_STATUS,
  API_ERROR_MESSAGES_ES,
  type ApiErrorCode,
  type ApiErrorEnvelope,
  apiErrorEnvelopeSchema,
} from '@anticipate/shared/api'
import { createProblem, VALIDATION_MESSAGES_ES } from '@anticipate/shared/errors'
import { applyDecorators } from '@nestjs/common'
import { ApiResponse } from '@nestjs/swagger'
import { CORRELATION_ID_RESPONSE_HEADER } from './api-enveloped-response.swagger.js'

/** Errores que puede dar cualquier ruta: límite de solicitudes, defecto del código y dependencia caída. */
export const COMMON_API_ERROR_CODES = [
  'RATE_LIMIT_EXCEEDED',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
] as const satisfies readonly ApiErrorCode[]

const EXAMPLE_CORRELATION_ID = '5f0c2a9e-8f3b-4c1d-9a51-2b7e4d6c8a10'
const EXAMPLE_TIMESTAMP = '2026-09-24T15:04:05.123Z'

/** Ejemplo del sobre de error de un código, con detalle cuando el código lo lleva. */
export function apiErrorExample(code: ApiErrorCode): ApiErrorEnvelope {
  const base = {
    success: false as const,
    statusCode: API_ERROR_HTTP_STATUS[code],
    code,
    message: API_ERROR_MESSAGES_ES[code],
    correlationId: EXAMPLE_CORRELATION_ID,
    timestamp: EXAMPLE_TIMESTAMP,
  }
  if (code === 'VALIDATION_ERROR') {
    return {
      ...base,
      details: {
        violations: [
          { field: 'contact.email', messages: [VALIDATION_MESSAGES_ES.advanceRequestForm.email] },
        ],
      },
    }
  }
  if (code === 'BUSINESS_RULES_VIOLATED') {
    return { ...base, details: { problems: [createProblem('NO_INVOICES')] } }
  }
  return base
}

/**
 * Documenta los errores posibles de una ruta: una respuesta por estado HTTP, con el esquema
 * `apiErrorEnvelopeSchema` de `shared`, la lista de códigos con su mensaje y un ejemplo por código.
 * Se pasan todos los códigos en una sola llamada (dos llamadas con el mismo estado se pisarían).
 */
export function ApiErrorResponses(...codes: readonly ApiErrorCode[]) {
  if (codes.length === 0) throw new TypeError('ApiErrorResponses() necesita al menos un código')
  const byStatus = new Map<number, ApiErrorCode[]>()
  for (const code of new Set(codes)) {
    const status = API_ERROR_HTTP_STATUS[code]
    byStatus.set(status, [...(byStatus.get(status) ?? []), code])
  }
  return applyDecorators(
    ...[...byStatus]
      .sort(([left], [right]) => left - right)
      .map(([status, statusCodes]) =>
        ApiResponse({
          status,
          description: statusCodes
            .map((code) => `\`${code}\`: ${API_ERROR_MESSAGES_ES[code]}`)
            .join(' · '),
          standardSchema: apiErrorEnvelopeSchema,
          headers: CORRELATION_ID_RESPONSE_HEADER,
          examples: Object.fromEntries(
            statusCodes.map((code) => [
              code,
              { summary: API_ERROR_MESSAGES_ES[code], value: apiErrorExample(code) },
            ]),
          ),
        }),
      ),
  )
}
