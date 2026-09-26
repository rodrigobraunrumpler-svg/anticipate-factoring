import type { AdvanceRequestCreatedEvent } from '@anticipate/shared/advance-request'
import type {
  AdvanceRequestNotificationReaderPort,
  AdvanceRequestNotificationView,
} from '#/modules/advance-requests/application/ports/advance-request-notification-reader.port.js'
import { type ClaimedOutboxEvent, OutboxDeadLetterError } from '#/modules/outbox/index.js'

const CREATED_EVENT_TYPE: AdvanceRequestCreatedEvent['type'] = 'advance-request.created'

/**
 * La solicitud del evento, leída al momento de enviar (el payload no lleva datos personales). Un
 * evento de otro tipo es `PAYLOAD_INVALID` y una solicitud que no existe, `AGGREGATE_NOT_FOUND`:
 * el publicador los pasa a `DEAD_LETTER` sin reintentar.
 */
export async function loadNotificationView(
  reader: AdvanceRequestNotificationReaderPort,
  event: ClaimedOutboxEvent,
): Promise<AdvanceRequestNotificationView> {
  if (event.eventType !== CREATED_EVENT_TYPE || event.payload.aggregateId !== event.aggregate.id) {
    throw new OutboxDeadLetterError(
      'PAYLOAD_INVALID',
      `evento ${event.id}: se esperaba ${CREATED_EVENT_TYPE} de la solicitud ${event.aggregate.id}`,
    )
  }
  const view = await reader.findById(event.aggregate.id)
  if (view === null) {
    throw new OutboxDeadLetterError(
      'AGGREGATE_NOT_FOUND',
      `evento ${event.id}: la solicitud ${event.aggregate.id} no existe`,
    )
  }
  return view
}
