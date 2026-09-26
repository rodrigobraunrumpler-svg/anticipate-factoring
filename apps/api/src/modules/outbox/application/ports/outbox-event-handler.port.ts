import type { ClaimedOutboxEvent } from '../../domain/types/outbox-event.types.js'

/**
 * Procesa los eventos de un `handler` (nombre estable, por ejemplo `email.supplier-confirmation`).
 * Vive en el módulo dueño del evento; el publicador lo recibe por `OUTBOX_EVENT_HANDLERS`. Para lo
 * que ningún reintento arregla lanza `OutboxDeadLetterError`; los errores del correo pasan tal cual.
 *
 * `signal` aborta al vencer `OUTBOX_HANDLER_TIMEOUT_MS` (motivo: el tope del handler). El handler se la
 * pasa a `EmailSenderPort.send` (y a toda operación que la acepte) y, si aborta, rechaza con
 * `signal.reason`. El publicador no escribe el resultado ni suelta la fila hasta que `handle` termina,
 * así el reintento no se superpone con un envío vivo. Un handler que ignora la señal y no termina
 * mientras el arriendo lo cubre se abandona: la fila se retoma recién al vencer el arriendo, y lo que
 * ese handler haga después ya no tiene garantía (por eso los adaptadores de correo respetan la señal).
 */
export interface OutboxEventHandler {
  readonly handler: string
  handle(
    event: ClaimedOutboxEvent,
    signal: AbortSignal,
  ): Promise<{ providerMessageId: string | null }>
}

export const OUTBOX_EVENT_HANDLERS = Symbol('OUTBOX_EVENT_HANDLERS')
