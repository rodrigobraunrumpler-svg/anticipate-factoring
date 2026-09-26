import { renderNewAdvanceRequestAlert } from '@anticipate/emails'
import type { AdvanceRequestNotificationReaderPort } from '#/modules/advance-requests/application/ports/advance-request-notification-reader.port.js'
import { ADVANCE_REQUEST_OUTBOX_HANDLERS } from '#/modules/advance-requests/domain/services/outbox-handlers.js'
import type { EmailSenderPort } from '#/modules/notifications/index.js'
import type { ClaimedOutboxEvent, OutboxEventHandler } from '#/modules/outbox/index.js'
import { loadNotificationView } from './load-notification-view.js'

export type TeamAlertEmailOptions = {
  /** `TEAM_NOTIFICATION_EMAIL`. */
  teamNotificationEmail: string
  /** `ADMIN_BASE_URL`, sin barra final. */
  adminBaseUrl: string
}

/** `email.team-alert`: avisa al equipo de una solicitud nueva, con el enlace al admin. */
export class TeamAlertEmailHandler implements OutboxEventHandler {
  readonly handler = ADVANCE_REQUEST_OUTBOX_HANDLERS.teamAlert

  constructor(
    private readonly notifications: AdvanceRequestNotificationReaderPort,
    private readonly sender: EmailSenderPort,
    private readonly options: TeamAlertEmailOptions,
  ) {}

  /** `signal` es el tope del publicador y llega hasta el envío, como en la confirmación. */
  async handle(
    event: ClaimedOutboxEvent,
    signal: AbortSignal,
  ): Promise<{ providerMessageId: string | null }> {
    const view = await loadNotificationView(this.notifications, event)
    const email = await renderNewAdvanceRequestAlert({
      publicCode: view.publicCode,
      payerName: view.payerShortName,
      supplierName: view.supplierLegalName,
      supplierRuc: view.supplierRuc,
      requestedAmount: view.requestedAmount,
      currency: view.currency,
      invoiceCount: view.invoiceCount,
      adminUrl: `${this.options.adminBaseUrl}/advance-requests/${view.id}`,
    })
    return this.sender.send(
      {
        to: { email: this.options.teamNotificationEmail },
        subject: email.subject,
        html: email.html,
        text: email.text,
        idempotencyKey: event.id,
      },
      signal,
    )
  }
}
