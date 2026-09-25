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
 * Envío de un correo. Los errores que lanza un adaptador son `RetryableEmailError` o
 * `PermanentEmailError`, y su mensaje nunca lleva datos personales (queda en los logs).
 */
export interface EmailSenderPort {
  send(email: OutgoingEmail): Promise<{ providerMessageId: string | null }>
}

export const EMAIL_SENDER = Symbol('EMAIL_SENDER')

/** El envío puede funcionar más tarde: red, 429 o 5xx del proveedor. */
export class RetryableEmailError extends Error {
  /** Espera que pidió el proveedor, en segundos (por ejemplo, el reinicio del límite de Brevo). */
  readonly retryAfterSeconds: number | undefined

  constructor(message: string, retryAfterSeconds?: number) {
    super(message)
    this.name = 'RetryableEmailError'
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/** Reintentar no cambia nada: dirección inválida, credenciales o remitente rechazados. */
export class PermanentEmailError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermanentEmailError'
  }
}
