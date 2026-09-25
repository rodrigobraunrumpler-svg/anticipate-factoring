/** Agregado dueño del evento. Cada tipo tiene su columna FK en `outbox_events` (hoy, `advance_request_id`). */
export type OutboxAggregate = { kind: 'ADVANCE_REQUEST'; id: string }

/** Todo lo que viaja en `outbox_events.payload`: ids, tipo y versión. Nunca datos personales. */
export type OutboxPayload = {
  id: string
  type: string
  version: 1
  occurredAt: string
  aggregateId: string
}

/** Una fila por handler. `dedupeKey` (por ejemplo `${payload.id}:${handler}`) evita encolar dos veces lo mismo. */
export type NewOutboxMessage = {
  handler: string
  dedupeKey: string
  eventType: string
  payload: OutboxPayload
  aggregate: OutboxAggregate
  correlationId: string | null
}

/** Un evento reclamado. `leaseToken` identifica este reclamo en toda escritura de vuelta. */
export type ClaimedOutboxEvent = NewOutboxMessage & {
  id: string
  leaseToken: string
  attempts: number
  maxAttempts: number
}
