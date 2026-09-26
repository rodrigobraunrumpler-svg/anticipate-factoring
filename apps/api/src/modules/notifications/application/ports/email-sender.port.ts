/** Destinatario. Sin `name`, el correo va solo a la dirección (por ejemplo, la casilla del equipo). */
export type EmailRecipient = { email: string; name?: string }

export type OutgoingEmail = {
  to: EmailRecipient
  subject: string
  html: string
  text: string
  /** Id de la fila del outbox: el proveedor la usa para no enviar dos veces el mismo correo. */
  idempotencyKey: string
  /** Etiquetas para filtrar en Brevo o en Mailpit (`X-Tags`), por ejemplo el nombre del handler. */
  tags?: readonly string[]
}

/**
 * Envío de un correo. Los errores que lanza un adaptador son `RetryableEmailError` (o su caso
 * `EmailAccountError`) o `PermanentEmailError`, y su mensaje nunca lleva datos personales ni secretos:
 * solo el estado y un código del proveedor (queda en los logs).
 *
 * `signal` es el tope de quien envía (el publicador del outbox lo aborta al vencer el tope del
 * handler, medido desde que el handler empezó). Con la señal ya abortada el adaptador no abre
 * conexión; si aborta durante el envío, corta la conexión o la petición en curso y rechaza con
 * `signal.reason`, como `fetch`. Así, cuando `send` termina no queda nada suyo en vuelo. El adaptador
 * tiene además su propio tope, que vale aunque la señal nunca avise.
 */
export interface EmailSenderPort {
  send(email: OutgoingEmail, signal: AbortSignal): Promise<{ providerMessageId: string | null }>
}

export const EMAIL_SENDER = Symbol('EMAIL_SENDER')

/**
 * El envío puede funcionar más tarde: red, tope de la petición, 408, 425, 429 o 5xx del proveedor. El
 * publicador lo reintenta con los intentos del evento y espera exponencial.
 */
export class RetryableEmailError extends Error {
  /**
   * Espera mínima que pidió el proveedor, en segundos (`Retry-After`, el reinicio del límite de Brevo).
   * Solo un número finito y no negativo: cualquier otro valor se descarta aquí, sin lanzar, porque un
   * error que falla al construirse taparía el fallo que describe.
   */
  readonly retryAfterSeconds: number | undefined

  constructor(message: string, retryAfterSeconds?: number) {
    super(message)
    this.name = 'RetryableEmailError'
    this.retryAfterSeconds =
      retryAfterSeconds !== undefined &&
      Number.isFinite(retryAfterSeconds) &&
      retryAfterSeconds >= 0
        ? retryAfterSeconds
        : undefined
  }
}

/**
 * El proveedor rechaza la cuenta, no el mensaje: clave inválida o rotada, IP no autorizada, sin
 * créditos o sin permiso para enviar. Mientras dura, falla todo envío, así que es reintentable (un
 * reintento sale en cuanto alguien lo corrige) y el publicador lo registra como error con el código
 * `EMAIL_ACCOUNT` para alertar.
 */
export class EmailAccountError extends RetryableEmailError {
  constructor(message: string, retryAfterSeconds?: number) {
    super(message, retryAfterSeconds)
    this.name = 'EmailAccountError'
  }
}

/** Reintentar no cambia nada: el proveedor rechaza este mensaje (dirección o contenido inválidos). */
export class PermanentEmailError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermanentEmailError'
  }
}
