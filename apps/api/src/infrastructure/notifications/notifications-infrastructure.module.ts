import { Global, Module } from '@nestjs/common'
import { APP_CONFIG, type AppConfig } from '#/common/config/index.js'
import { EMAIL_SENDER, type EmailSenderPort } from '#/modules/notifications/index.js'
import { BrevoEmailSender } from './brevo/brevo-email-sender.adapter.js'
import { FakeEmailSender } from './fake/fake-email-sender.adapter.js'
import { SmtpEmailSender } from './smtp/smtp-email-sender.adapter.js'

/**
 * El adaptador según `MAIL_TRANSPORT`. La configuración ya exige `BREVO_API_KEY` con `brevo` y
 * `SMTP_HOST` con `smtp`; aquí solo se hace explícito. El tope de cada envío es el del handler del
 * outbox: ninguna petición sigue viva después de que el publicador la dio por vencida.
 */
export function createEmailSender(config: AppConfig): EmailSenderPort {
  const { mail } = config
  const timeoutMs = config.outbox.handlerTimeoutMs
  switch (mail.transport) {
    case 'brevo':
      if (mail.brevoApiKey === undefined)
        throw new Error('MAIL_TRANSPORT=brevo exige BREVO_API_KEY')
      return new BrevoEmailSender({
        apiKey: mail.brevoApiKey,
        fromEmail: mail.fromEmail,
        fromName: mail.fromName,
        requestTimeoutMs: timeoutMs,
      })
    case 'smtp':
      if (mail.smtpHost === undefined) throw new Error('MAIL_TRANSPORT=smtp exige SMTP_HOST')
      return new SmtpEmailSender({
        host: mail.smtpHost,
        port: mail.smtpPort,
        fromEmail: mail.fromEmail,
        fromName: mail.fromName,
        timeoutMs,
      })
    case 'fake':
      return new FakeEmailSender()
  }
}

/** Global: `EMAIL_SENDER` para los handlers de cualquier módulo. */
@Global()
@Module({
  providers: [{ provide: EMAIL_SENDER, inject: [APP_CONFIG], useFactory: createEmailSender }],
  exports: [EMAIL_SENDER],
})
export class NotificationsInfrastructureModule {}
