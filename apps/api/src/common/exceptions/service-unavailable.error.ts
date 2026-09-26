import { ApplicationError } from './application-error.js'

export type ServiceUnavailableErrorOptions = {
  readonly cause?: unknown
  /**
   * Segundos que el cliente espera antes de reintentar: el filtro HTTP los responde en `Retry-After`.
   * Un entero positivo.
   */
  readonly retryAfterSeconds?: number
}

/**
 * 503 `SERVICE_UNAVAILABLE`: una dependencia (base, almacenamiento) no respondió. El diagnóstico y la
 * causa van a los logs; `retryAfterSeconds`, si viene, a la cabecera `Retry-After`.
 */
export class ServiceUnavailableError extends ApplicationError<'SERVICE_UNAVAILABLE'> {
  readonly retryAfterSeconds: number | undefined

  constructor(diagnostic?: string, options: ServiceUnavailableErrorOptions = {}) {
    const { retryAfterSeconds } = options
    if (
      retryAfterSeconds !== undefined &&
      (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 1)
    ) {
      throw new RangeError(
        `Retry-After debe ser un entero positivo de segundos: ${retryAfterSeconds}`,
      )
    }
    super('SERVICE_UNAVAILABLE', { diagnostic, cause: options.cause })
    this.retryAfterSeconds = retryAfterSeconds
  }
}
