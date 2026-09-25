import type { OutboxAggregate } from '../types/outbox-event.types.js'

/** Catálogo cerrado de `outbox_events.last_error`: nunca un texto libre, que podría llevar datos personales. */
export const OUTBOX_FAILURE_CODES = [
  'EMAIL_RETRYABLE',
  'EMAIL_PERMANENT',
  'HANDLER_TIMEOUT',
  'HANDLER_MISSING',
  'PAYLOAD_INVALID',
  'AGGREGATE_NOT_FOUND',
  'UNEXPECTED',
] as const

export type OutboxFailureCode = (typeof OUTBOX_FAILURE_CODES)[number]

/** Lo lanza un handler cuando ningún reintento lo arregla: el publicador pasa el evento a `DEAD_LETTER` con su código. */
export class OutboxDeadLetterError extends Error {
  constructor(
    readonly failureCode: Extract<OutboxFailureCode, 'PAYLOAD_INVALID' | 'AGGREGATE_NOT_FOUND'>,
    message: string,
  ) {
    super(message)
    this.name = new.target.name
  }
}

/** El agregado del evento ya no existe (por ejemplo, la vista de la solicitud no encuentra la fila). */
export class OutboxAggregateNotFoundError extends OutboxDeadLetterError {
  constructor(aggregate: OutboxAggregate) {
    super('AGGREGATE_NOT_FOUND', `No existe el agregado ${aggregate.kind} ${aggregate.id}`)
  }
}

/** El payload no es el que espera el handler. `reason` nunca repite valores del payload. */
export class OutboxPayloadInvalidError extends OutboxDeadLetterError {
  constructor(reason: string) {
    super('PAYLOAD_INVALID', `Payload del outbox inválido: ${reason}`)
  }
}
