import type {
  NewOutboxMessage,
  OutboxAggregate,
  OutboxPayload,
} from '../types/outbox-event.types.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
/** Igual que la CHECK `outbox_events_handler_check`. */
const HANDLER_NAME_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/

/** Largos de `outbox_events.handler`, `dedupe_key` y `event_type`. */
export const OUTBOX_HANDLER_MAX_LENGTH = 60
export const OUTBOX_DEDUPE_KEY_MAX_LENGTH = 200
export const OUTBOX_EVENT_TYPE_MAX_LENGTH = 60

export function isValidOutboxHandlerName(name: string): boolean {
  return name.length <= OUTBOX_HANDLER_MAX_LENGTH && HANDLER_NAME_PATTERN.test(name)
}

export function isOutboxPayload(value: unknown): value is OutboxPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { id, type, version, occurredAt, aggregateId } = value as Record<string, unknown>
  return (
    typeof id === 'string' &&
    UUID_PATTERN.test(id) &&
    typeof type === 'string' &&
    type.trim() !== '' &&
    version === 1 &&
    typeof occurredAt === 'string' &&
    ISO_INSTANT_PATTERN.test(occurredAt) &&
    !Number.isNaN(Date.parse(occurredAt)) &&
    typeof aggregateId === 'string' &&
    UUID_PATTERN.test(aggregateId)
  )
}

/** El payload tiene la forma de `OutboxPayload` y habla del mismo evento y agregado que la fila. */
export function hasValidOutboxPayload(message: {
  payload: unknown
  eventType: string
  aggregate: OutboxAggregate
}): boolean {
  return (
    isOutboxPayload(message.payload) &&
    message.payload.type === message.eventType &&
    message.payload.aggregateId === message.aggregate.id
  )
}

/** Por qué un mensaje no se puede encolar, o `null` si está bien. No repite valores del payload. */
export function outboxMessageProblem(message: NewOutboxMessage): string | null {
  if (!isValidOutboxHandlerName(message.handler)) return 'handler inválido'
  if (message.dedupeKey.trim() === '' || message.dedupeKey.length > OUTBOX_DEDUPE_KEY_MAX_LENGTH) {
    return 'dedupeKey vacía o de más de 200 caracteres'
  }
  if (message.eventType.trim() === '' || message.eventType.length > OUTBOX_EVENT_TYPE_MAX_LENGTH) {
    return 'eventType vacío o de más de 60 caracteres'
  }
  if (!hasValidOutboxPayload(message)) return 'payload inválido o de otro evento o agregado'
  return null
}
