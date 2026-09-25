import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { CORRELATION_ID_HEADER } from '#/common/constants/http-headers.constants.js'

/** Id de correlación que la API acepta de afuera: sin espacios ni comas, de 1 a 128 caracteres. */
export const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

type CorrelatedMessage = IncomingMessage & { correlationId?: string }

/**
 * Id de correlación de la petición, resuelto una sola vez: la cabecera `x-correlation-id` si cumple
 * el formato o, si no, un UUID nuevo. Queda en `req.correlationId`, así que el middleware, el log de
 * pino, el filtro, el interceptor, la solicitud y el outbox leen el mismo valor. Una cabecera repetida
 * llega unida con ", " y no cumple el formato: se reemplaza.
 */
export function resolveCorrelationId(req: CorrelatedMessage): string {
  if (req.correlationId !== undefined) return req.correlationId
  const received = req.headers[CORRELATION_ID_HEADER]
  const correlationId =
    typeof received === 'string' && CORRELATION_ID_PATTERN.test(received) ? received : randomUUID()
  req.correlationId = correlationId
  return correlationId
}
