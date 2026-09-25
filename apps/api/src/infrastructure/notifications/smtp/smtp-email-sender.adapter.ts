import { createTransport, type Transporter } from 'nodemailer'
import {
  type EmailSenderPort,
  type OutgoingEmail,
  PermanentEmailError,
  RetryableEmailError,
} from '#/modules/notifications/index.js'

export type SmtpEmailSenderOptions = {
  host: string
  port: number
  fromEmail: string
  fromName: string
  /** Tope de conexión, saludo y socket: el mismo que el del handler del outbox. */
  timeoutMs: number
}

/** SMTP hacia Mailpit en desarrollo: ningún correo de prueba le llega a una persona real. */
export class SmtpEmailSender implements EmailSenderPort {
  private readonly transporter: Transporter

  constructor(private readonly options: SmtpEmailSenderOptions) {
    this.transporter = createTransport({
      host: options.host,
      port: options.port,
      secure: false,
      ignoreTLS: true,
      connectionTimeout: options.timeoutMs,
      greetingTimeout: options.timeoutMs,
      socketTimeout: options.timeoutMs,
    })
  }

  async send(email: OutgoingEmail): Promise<{ providerMessageId: string | null }> {
    const headers: Record<string, string> = { 'X-Idempotency-Key': email.idempotencyKey }
    if (email.tags !== undefined && email.tags.length > 0) headers['X-Tags'] = email.tags.join(',')
    try {
      const info = await this.transporter.sendMail({
        from: { name: this.options.fromName, address: this.options.fromEmail },
        to:
          email.to.name === undefined
            ? email.to.email
            : { name: email.to.name, address: email.to.email },
        subject: email.subject,
        html: email.html,
        text: email.text,
        headers,
      })
      const messageId: unknown = info.messageId
      return { providerMessageId: typeof messageId === 'string' ? messageId : null }
    } catch (error) {
      throw toEmailError(error)
    }
  }

  close(): void {
    this.transporter.close()
  }
}

/**
 * 5xx del servidor o un sobre inválido (`EENVELOPE`) son permanentes; lo demás (red, 4xx) se
 * reintenta. El mensaje lleva solo códigos: el texto de un rechazo SMTP suele repetir la dirección.
 */
function toEmailError(error: unknown): Error {
  const { code, responseCode } = (typeof error === 'object' && error !== null ? error : {}) as {
    code?: unknown
    responseCode?: unknown
  }
  const detail = [
    typeof code === 'string' ? code : 'sin código',
    typeof responseCode === 'number' ? responseCode : '',
  ]
    .join(' ')
    .trim()
  const permanent =
    code === 'EENVELOPE' ||
    (typeof responseCode === 'number' && responseCode >= 500 && responseCode < 600)
  return permanent
    ? new PermanentEmailError(`SMTP ${detail}`)
    : new RetryableEmailError(`SMTP ${detail}`)
}
