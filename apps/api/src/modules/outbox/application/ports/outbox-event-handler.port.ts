import type { ClaimedOutboxEvent } from '../../domain/types/outbox-event.types.js'

/**
 * Procesa los eventos de un `handler` (nombre estable, por ejemplo `email.supplier-confirmation`).
 * Vive en el módulo dueño del evento; el publicador lo recibe por `OUTBOX_EVENT_HANDLERS`. Para lo
 * que ningún reintento arregla lanza `OutboxDeadLetterError`; los errores del correo pasan tal cual.
 */
export interface OutboxEventHandler {
  readonly handler: string
  handle(event: ClaimedOutboxEvent): Promise<{ providerMessageId: string | null }>
}

export const OUTBOX_EVENT_HANDLERS = Symbol('OUTBOX_EVENT_HANDLERS')
