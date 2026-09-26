import { ApplicationError } from '#/common/exceptions/index.js'

/**
 * La `Idempotency-Key` ya se usó con otros datos (otra huella). Devolver la solicitud original le
 * haría creer al proveedor que se guardó algo que nunca se guardó, así que se informa la
 * reutilización: 422 `IDEMPOTENCY_KEY_REUSED` con el mensaje de `API_ERROR_MESSAGES_ES`. La clave
 * (un UUID sin datos personales) queda solo en el diagnóstico, para el log.
 */
export class IdempotencyKeyReusedError extends ApplicationError<'IDEMPOTENCY_KEY_REUSED'> {
  constructor(idempotencyKey: string) {
    super('IDEMPOTENCY_KEY_REUSED', {
      diagnostic: `Idempotency-Key ${idempotencyKey} reutilizada con otra huella`,
    })
  }
}
