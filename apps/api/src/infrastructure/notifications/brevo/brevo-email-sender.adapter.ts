import { z } from 'zod'
import {
  EmailAccountError,
  type EmailSenderPort,
  type OutgoingEmail,
  PermanentEmailError,
  RetryableEmailError,
} from '#/modules/notifications/index.js'

const BREVO_SEND_URL = 'https://api.brevo.com/v3/smtp/email'
/** `messageId` de un envío; `messageIds` de uno programado o por lotes. */
const acceptedSchema = z.union([
  z.object({ messageId: z.string().min(1) }),
  z.object({ messageIds: z.array(z.string().min(1)).min(1) }),
])
/** Solo un código con la forma de los de Brevo llega al mensaje del error: nunca un texto libre. */
const errorSchema = z.object({ code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/) })

/**
 * Hablan de la cuenta, no del mensaje: clave inválida o rotada, o IP no autorizada (401), sin créditos
 * (402), sin permiso para enviar (403). Los códigos de Brevo del mismo caso cuentan con cualquier estado.
 */
const ACCOUNT_STATUSES: ReadonlySet<number> = new Set([401, 402, 403])
const ACCOUNT_CODES: ReadonlySet<string> = new Set([
  'unauthorized',
  'not_enough_credits',
  'permission_denied',
  'account_under_validation',
])
/** 4xx pasajeros: tope de la petición (408), demasiado pronto (425) y límite de envíos (429). */
const TRANSIENT_CLIENT_STATUSES: ReadonlySet<number> = new Set([408, 425, 429])

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
 * `headers.idempotencyKey` del cuerpo: un reintento de un envío que sí salió no se repite. Si la señal
 * de quien envía aborta, la petición se corta y `send` rechaza con su motivo.
 *
 * Cada respuesta se clasifica por lo que significa su estado:
 * - 2xx: aceptado.
 * - 401, 402, 403 (o un código de cuenta): `EmailAccountError`, reintentable. Falla todo envío hasta que
 *   alguien corrige la cuenta; mandarlo a `DEAD_LETTER` en el primer intento perdería cada correo.
 * - 408, 425, 429, 5xx, red y tope: `RetryableEmailError`, con la espera de `Retry-After` o de
 *   `x-sib-ratelimit-reset` si viene.
 * - Otro 4xx (400, 404, 413, 422…): Brevo rechaza este mensaje, `PermanentEmailError`.
 * - Cualquier otro estado (un 1xx o 3xx inesperado) no dice nada del mensaje: reintentable.
 *
 * Los errores llevan solo el estado y el código de Brevo, nunca el cuerpo (puede repetir la dirección)
 * ni la clave.
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
    const { status } = response
    if (status >= 200 && status < 300) return { providerMessageId: messageIdOf(body) }
    const brevoError = errorSchema.safeParse(body)
    const code = brevoError.success ? brevoError.data.code : undefined
    const detail = `Brevo ${status} ${code ?? 'sin código'}`
    if (ACCOUNT_STATUSES.has(status) || (code !== undefined && ACCOUNT_CODES.has(code))) {
      throw new EmailAccountError(detail, retryAfterSeconds(response))
    }
    if (status >= 400 && status < 500 && !TRANSIENT_CLIENT_STATUSES.has(status)) {
      throw new PermanentEmailError(detail)
    }
    throw new RetryableEmailError(detail, retryAfterSeconds(response))
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

/** El id de Brevo de un envío aceptado, o `null` si el cuerpo no lo trae (un 204, por ejemplo). */
function messageIdOf(body: unknown): string | null {
  const accepted = acceptedSchema.safeParse(body)
  if (!accepted.success) return null
  return 'messageId' in accepted.data
    ? accepted.data.messageId
    : (accepted.data.messageIds[0] ?? null)
}

/**
 * La espera que pide Brevo, en segundos enteros: la mayor entre `Retry-After` (segundos o fecha HTTP)
 * y `x-sib-ratelimit-reset` (segundos hasta que el límite se reinicia). `undefined` si ninguna sirve.
 */
function retryAfterSeconds(response: Response): number | undefined {
  const waits = [
    retryAfterHeaderSeconds(response),
    positiveSeconds(Number(response.headers.get('x-sib-ratelimit-reset'))),
  ].filter((seconds): seconds is number => seconds !== undefined)
  return waits.length === 0 ? undefined : Math.max(...waits)
}

/**
 * `Retry-After` (RFC 9110): segundos, o una fecha HTTP que se mide contra la cabecera `Date` de la misma
 * respuesta (el reloj de Brevo) o, si falta, contra el reloj local.
 */
function retryAfterHeaderSeconds(response: Response): number | undefined {
  const value = response.headers.get('retry-after')?.trim()
  if (value === undefined || value === '') return undefined
  if (/^\d+$/.test(value)) return positiveSeconds(Number(value))
  // Una fecha HTTP nombra el día y el mes: sin letras no es una fecha (`Date.parse('-5')` sí da una).
  if (!/[a-z]/i.test(value)) return undefined
  const until = Date.parse(value)
  const sentAt = Date.parse(response.headers.get('date') ?? '')
  const now = Number.isFinite(sentAt) ? sentAt : Date.now()
  return positiveSeconds((until - now) / 1000)
}

function positiveSeconds(seconds: number): number | undefined {
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined
}
