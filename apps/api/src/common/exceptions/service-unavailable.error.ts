import { ApplicationError } from './application-error.js'

export type ServiceUnavailableErrorOptions = { readonly cause?: unknown }

/**
 * 503 `SERVICE_UNAVAILABLE`: una dependencia (base, almacenamiento) no respondió. El diagnóstico y la
 * causa van a los logs.
 */
export class ServiceUnavailableError extends ApplicationError<'SERVICE_UNAVAILABLE'> {
  constructor(diagnostic?: string, options: ServiceUnavailableErrorOptions = {}) {
    super('SERVICE_UNAVAILABLE', { diagnostic, cause: options.cause })
  }
}
