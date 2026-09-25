import type {
  ClaimedOutboxEvent,
  NewOutboxMessage,
  OutboxAggregate,
  OutboxPayload,
} from '#/modules/outbox/index.js'

/** Fila del `RETURNING` de `claimDue`, con alias en camelCase. */
export type OutboxEventRow = {
  id: string
  handler: string
  dedupeKey: string
  eventType: string
  payload: unknown
  advanceRequestId: string | null
  correlationId: string | null
  leaseToken: string
  attempts: number
  maxAttempts: number
}

/** Un registro de `jsonb_to_recordset` en el INSERT de `insertOutboxMessages` (columnas en snake_case). */
export type OutboxInsertRecord = {
  handler: string
  dedupe_key: string
  event_type: string
  payload: OutboxPayload
  advance_request_id: string
  correlation_id: string | null
}

/**
 * `payload` sale tal como está en la base: el publicador lo valida con `hasValidOutboxPayload` antes
 * de dárselo a un handler y, si no cumple, lo pasa a `DEAD_LETTER` con `PAYLOAD_INVALID`.
 */
export function toClaimedOutboxEvent(row: OutboxEventRow): ClaimedOutboxEvent {
  return {
    id: row.id,
    handler: row.handler,
    dedupeKey: row.dedupeKey,
    eventType: row.eventType,
    payload: row.payload as OutboxPayload,
    aggregate: aggregateOf(row),
    correlationId: row.correlationId,
    leaseToken: row.leaseToken,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
  }
}

/** Copia solo los campos de `OutboxPayload`: una propiedad de más (un correo, un nombre) nunca llega a la base. */
export function toOutboxInsertRecord(message: NewOutboxMessage): OutboxInsertRecord {
  const { id, type, version, occurredAt, aggregateId } = message.payload
  const record = {
    handler: message.handler,
    dedupe_key: message.dedupeKey,
    event_type: message.eventType,
    payload: { id, type, version, occurredAt, aggregateId },
    correlation_id: message.correlationId,
  }
  switch (message.aggregate.kind) {
    case 'ADVANCE_REQUEST':
      return { ...record, advance_request_id: message.aggregate.id }
  }
}

function aggregateOf(row: OutboxEventRow): OutboxAggregate {
  if (row.advanceRequestId !== null) return { kind: 'ADVANCE_REQUEST', id: row.advanceRequestId }
  // La CHECK outbox_events_aggregate_check (num_nonnulls(...) = 1) impide llegar aquí.
  throw new Error(`El evento del outbox ${row.id} no tiene agregado`)
}
