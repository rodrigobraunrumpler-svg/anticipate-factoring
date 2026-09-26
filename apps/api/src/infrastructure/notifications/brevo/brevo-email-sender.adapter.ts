import { z } from 'zod'
import {
  type EmailSenderPort,
  type OutgoingEmail,
  PermanentEmailError,
  RetryableEmailError,
} from '#/modules/notifications/index.js'

const BREVO_SEND_URL = 'https://api.brevo.com/v3/smtp/email'
const acceptedSchema = z.object({ messageId: z.string().min(1) })
const errorSchema = z.object({ code: z.string().min(1) })

export type BrevoEmailSenderOptions = {
  apiKey: string
  fromEmail: string
  fromName: string
  /**
   * Tope propio de la petición (el del handler del outbox): vale aunque la señal de quien envía nunca
   * avise. Con el publicador, la señal corta antes, medida desde que empezó el handler.
   */
  requestTimeoutMs: number
}

/**
 * API transaccional de Brevo. La clave de idempotencia (el id de la fila del outbox) va en
 * `headers.idempotencyKey` del cuerpo: un reintento de un envío que sí salió no se repite. Los errores
 * llevan solo el estado y el código de Brevo, nunca el cuerpo (puede repetir la dirección). Si la
 * señal de quien envía aborta, la petición se corta y `send` rechaza con su motivo.
 */
export class BrevoEmailSender implements EmailSenderPort {
  constructor(private readonly options: BrevoEmailSenderOptions) {}

  async send(
    email: OutgoingEmail,
    signal: AbortSignal,
  ): Promise<{ providerMessageId: string | null }> {
    signal.throwIfAborted()
    let response: Response
    try {
      response = await fetch(BREVO_SEND_URL, {
        method: 'POST',
        headers: {
          'api-key': this.options.apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(this.toBody(email)),
        // Corta también la lectura del cuerpo. Si aborta después del 201, el correo ya salió: vale el estado.
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.options.requestTimeoutMs)]),
      })
    } catch (error) {
      signal.throwIfAborted()
      throw new RetryableEmailError(
        `Brevo sin respuesta (${error instanceof Error ? error.name : 'error'})`,
      )
    }
    const body = await readJson(response)
    if (response.status === 201 || response.status === 202) {
      const accepted = acceptedSchema.safeParse(body)
      return { providerMessageId: accepted.success ? accepted.data.messageId : null }
    }
    const brevoError = errorSchema.safeParse(body)
    const detail = `Brevo ${response.status} ${brevoError.success ? brevoError.data.code : 'sin código'}`
    if (response.status === 429) throw new RetryableEmailError(detail, retryAfterSeconds(response))
    if (response.status >= 500) throw new RetryableEmailError(detail)
    throw new PermanentEmailError(detail)
  }

  private toBody(email: OutgoingEmail) {
    const { to } = email
    return {
      sender: { email: this.options.fromEmail, name: this.options.fromName },
      to: [to.name === undefined ? { email: to.email } : { email: to.email, name: to.name }],
      subject: email.subject,
      htmlContent: email.html,
      textContent: email.text,
      headers: { idempotencyKey: email.idempotencyKey },
      ...(email.tags !== undefined && email.tags.length > 0 ? { tags: [...email.tags] } : {}),
    }
  }
}

/** El cuerpo como JSON, o `null` si no se pudo leer o no es JSON. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text()) as unknown
  } catch {
    return null
  }
}

/** `x-sib-ratelimit-reset`: segundos hasta que Brevo vuelve a aceptar envíos. */
function retryAfterSeconds(response: Response): number | undefined {
  const seconds = Number(response.headers.get('x-sib-ratelimit-reset'))
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined
}
