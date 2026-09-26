import { renderAdvanceRequestConfirmation } from '@anticipate/emails'
import type { AdvanceRequestNotificationReaderPort } from '#/modules/advance-requests/application/ports/advance-request-notification-reader.port.js'
import { ADVANCE_REQUEST_OUTBOX_HANDLERS } from '#/modules/advance-requests/domain/services/outbox-handlers.js'
import type { EmailSenderPort } from '#/modules/notifications/index.js'
import type { ClaimedOutboxEvent, OutboxEventHandler } from '#/modules/outbox/index.js'
import { loadNotificationView } from './load-notification-view.js'

/** `email.supplier-confirmation`: le confirma al proveedor que recibimos su solicitud. */
export class SupplierConfirmationEmailHandler implements OutboxEventHandler {
  readonly handler = ADVANCE_REQUEST_OUTBOX_HANDLERS.supplierConfirmation

  constructor(
    private readonly notifications: AdvanceRequestNotificationReaderPort,
    private readonly sender: EmailSenderPort,
  ) {}

  /**
   * `signal` es el tope del publicador y llega hasta el envío: al vencer, `send` corta la conexión
   * y rechaza con su motivo. El publicador no suelta la fila hasta que esto termina, así que un
   * reintento nunca se superpone con este envío.
   */
  async handle(
    event: ClaimedOutboxEvent,
    signal: AbortSignal,
  ): Promise<{ providerMessageId: string | null }> {
    const view = await loadNotificationView(this.notifications, event)
    const email = await renderAdvanceRequestConfirmation({
      contactName: view.contactFullName,
      publicCode: view.publicCode,
      payerName: view.payerShortName,
      requestedAmount: view.requestedAmount,
      currency: view.currency,
      invoiceCount: view.invoiceCount,
    })
    // La clave de idempotencia es el id de la fila: un reenvío tras un arriendo perdido no duplica.
    return this.sender.send(
      {
        to: { email: view.contactEmail, name: view.contactFullName },
        subject: email.subject,
        html: email.html,
        text: email.text,
        idempotencyKey: event.id,
      },
      signal,
    )
  }
}
