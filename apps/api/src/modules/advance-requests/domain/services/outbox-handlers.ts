/**
 * Handlers del outbox que registra este módulo. Cada evento `advance-request.created` produce una
 * fila por handler. Los nombres son texto (sin enum en la base) y cumplen el CHECK
 * `outbox_events_handler_check`; el publicador no arranca si alguno no tiene handler registrado.
 */
export const ADVANCE_REQUEST_OUTBOX_HANDLERS = {
  supplierConfirmation: 'email.supplier-confirmation',
  teamAlert: 'email.team-alert',
} as const

export type AdvanceRequestOutboxHandler =
  (typeof ADVANCE_REQUEST_OUTBOX_HANDLERS)[keyof typeof ADVANCE_REQUEST_OUTBOX_HANDLERS]

/**
 * Clave de deduplicación de una fila del outbox (`outbox_events_dedupe_key_key`): una por handler y
 * evento, así el mismo correo nunca se encola dos veces para el mismo evento.
 */
export function advanceRequestOutboxDedupeKey(
  handler: AdvanceRequestOutboxHandler,
  eventId: string,
): string {
  return `${handler}:${eventId}`
}
