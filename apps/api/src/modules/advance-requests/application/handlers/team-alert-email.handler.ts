import { renderNewAdvanceRequestAlert } from '@anticipate/emails'
import type { AdvanceRequestNotificationReaderPort } from '#/modules/advance-requests/application/ports/advance-request-notification-reader.port.js'
import { ADVANCE_REQUEST_OUTBOX_HANDLERS } from '#/modules/advance-requests/domain/services/outbox-handlers.js'
import type { EmailSenderPort } from '#/modules/notifications/index.js'
import type { ClaimedOutboxEvent, OutboxEventHandler } from '#/modules/outbox/index.js'
import { loadNotificationView } from './load-notification-view.js'
import { toTeamAlertEmailData } from './team-alert-email-data.js'

export type TeamAlertEmailOptions = {
  /** `TEAM_NOTIFICATION_EMAIL`. */
  teamNotificationEmail: string
  /** `ADMIN_BASE_URL`, sin barra final, o `null` si no está configurada: el correo no lleva enlace. */
  adminBaseUrl: string | null
}

/**
 * `email.team-alert`: avisa al equipo de una solicitud nueva con lo necesario para contactar al
 * proveedor desde el correo (contacto, empresa, monto y facturas), y con el enlace al admin solo si
 * existe. Los datos se leen al enviar: el payload del outbox no lleva datos personales, y este
 * handler no los escribe en ningún log.
 */
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
    const view = await loadNotificationView(event, (id) => this.notifications.findTeamAlertById(id))
    const email = await renderNewAdvanceRequestAlert(
      toTeamAlertEmailData(view, { adminBaseUrl: this.options.adminBaseUrl }),
    )
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
