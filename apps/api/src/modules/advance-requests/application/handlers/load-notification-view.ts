import type { AdvanceRequestCreatedEvent } from '@anticipate/shared/advance-request'
import { type ClaimedOutboxEvent, OutboxDeadLetterError } from '#/modules/outbox/index.js'

const CREATED_EVENT_TYPE: AdvanceRequestCreatedEvent['type'] = 'advance-request.created'

/**
 * La solicitud del evento, leída al momento de enviar con `find` (el payload no lleva datos
 * personales: cada correo lee solo sus columnas). Un evento de otro tipo es `PAYLOAD_INVALID`, sin
 * leer nada, y una solicitud que no existe, `AGGREGATE_NOT_FOUND`: el publicador los pasa a
 * `DEAD_LETTER` sin reintentar.
 */
export async function loadNotificationView<TView>(
  event: ClaimedOutboxEvent,
  find: (id: string) => Promise<TView | null>,
): Promise<TView> {
  if (event.eventType !== CREATED_EVENT_TYPE || event.payload.aggregateId !== event.aggregate.id) {
    throw new OutboxDeadLetterError(
      'PAYLOAD_INVALID',
      `evento ${event.id}: se esperaba ${CREATED_EVENT_TYPE} de la solicitud ${event.aggregate.id}`,
    )
  }
  const view = await find(event.aggregate.id)
  if (view === null) {
    throw new OutboxDeadLetterError(
      'AGGREGATE_NOT_FOUND',
      `evento ${event.id}: la solicitud ${event.aggregate.id} no existe`,
    )
  }
  return view
}
