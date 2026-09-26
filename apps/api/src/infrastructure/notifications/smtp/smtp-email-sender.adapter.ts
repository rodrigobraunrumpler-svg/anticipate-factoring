import { connect, type Socket } from 'node:net'
import { createTransport } from 'nodemailer'
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
  /**
   * Tope propio de cada envío, conexión incluida (el del handler del outbox): vale aunque la señal de
   * quien envía nunca avise. Con el publicador, la señal corta antes, medida desde que empezó el handler.
   */
  timeoutMs: number
}

/**
 * SMTP hacia Mailpit en desarrollo: ningún correo de prueba le llega a una persona real. Cada envío
 * usa su propia conexión (como nodemailer sin pool), pero la abre el adaptador y se la entrega a
 * nodemailer (`getSocket`): si la señal de quien envía aborta, o vence el tope propio, el socket se
 * destruye en cualquier etapa y `send` rechaza sin dejar nada en vuelo (con el motivo de la señal,
 * si fue ella).
 */
export class SmtpEmailSender implements EmailSenderPort {
  private closed = false

  constructor(private readonly options: SmtpEmailSenderOptions) {}

  async send(
    email: OutgoingEmail,
    signal: AbortSignal,
  ): Promise<{ providerMessageId: string | null }> {
    signal.throwIfAborted()
    if (this.closed) throw new RetryableEmailError('SMTP cerrado')
    const { host, port, timeoutMs } = this.options
    const stop = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    let socket: Socket | undefined
    const transporter = createTransport({
      host,
      port,
      secure: false,
      ignoreTLS: true,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs,
      getSocket: (_options, callback) => {
        openSocket(host, port, stop).then(
          (opened) => {
            if (stop.aborted) {
              opened.destroy()
              callback(asError(stop.reason))
              return
            }
            socket = opened
            callback(null, { connection: opened })
          },
          (error: unknown) => callback(asError(error)),
        )
      },
    })
    // Al abortar: destruye el socket y rechaza ya. Con el socket destruido no sale nada más, y nodemailer
    // puede tardar en informarlo (un cierre durante el saludo lo reporta recién después de un segundo).
    let rejectAborted: (reason: unknown) => void = () => {}
    const aborted = new Promise<never>((_, reject) => {
      rejectAborted = reject
    })
    const cut = () => {
      socket?.destroy()
      rejectAborted(stop.reason)
    }
    stop.addEventListener('abort', cut, { once: true })
    const headers: Record<string, string> = { 'X-Idempotency-Key': email.idempotencyKey }
    if (email.tags !== undefined && email.tags.length > 0) headers['X-Tags'] = email.tags.join(',')
    try {
      const sending = transporter.sendMail({
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
      const info = await Promise.race([sending, aborted])
      const messageId: unknown = info.messageId
      return { providerMessageId: typeof messageId === 'string' ? messageId : null }
    } catch (error) {
      signal.throwIfAborted()
      if (stop.aborted) throw new RetryableEmailError('SMTP sin respuesta (TimeoutError)')
      throw toEmailError(error)
    } finally {
      stop.removeEventListener('abort', cut)
      socket?.destroy()
      transporter.close()
    }
  }

  /** No admite envíos nuevos (rechazan como reintentables); los que están en curso terminan. */
  close(): void {
    this.closed = true
  }
}

/** Abre la conexión TCP; si `signal` aborta antes de conectar, destruye el socket y rechaza con su motivo. */
function openSocket(host: string, port: number, signal: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const socket = connect({ host, port })
    const settle = () => {
      socket.off('connect', onConnect)
      socket.off('error', onError)
      signal.removeEventListener('abort', onAbort)
    }
    const onConnect = () => {
      settle()
      // nodemailer informa los errores del socket mientras lo usa; este oyente solo evita que un
      // 'error' tardío, después de que nodemailer lo soltó, tumbe el proceso.
      socket.on('error', () => {})
      resolve(socket)
    }
    const onError = (error: Error) => {
      settle()
      socket.destroy()
      reject(error)
    }
    const onAbort = () => {
      settle()
      socket.destroy()
      reject(signal.reason)
    }
    socket.once('connect', onConnect)
    socket.once('error', onError)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason))
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
