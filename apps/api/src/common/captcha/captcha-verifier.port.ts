/** Lo que recibe el verificador: el token del navegador, la IP del cliente y la clave del envío. */
export type CaptchaVerificationInput = {
  token: string
  remoteIp: string
  /** `Idempotency-Key` del envío, solo si es un UUID válido: permite revalidar en un reintento. */
  idempotencyKey?: string
}

/**
 * El proveedor respondió, pero se negó a verificar por un motivo que no es el token del visitante: la
 * clave secreta falta, no vale o se rotó, la petición salió mal formada o el proveedor falló por
 * dentro. Ningún envío puede pasar mientras dure, y no es culpa de quien envía: la API responde 503
 * `SERVICE_UNAVAILABLE`, nunca 403. El adaptador ya lo registró con nivel error y los códigos del
 * proveedor (nunca el token ni el secreto); `errorCodes` los repite, ya acotados, para los tests.
 */
export class CaptchaProviderRefusedError extends Error {
  readonly errorCodes: readonly string[]

  constructor(errorCodes: readonly string[]) {
    super(
      `El proveedor del captcha se negó a verificar (${errorCodes.join(', ') || 'sin código'}).`,
    )
    this.name = 'CaptchaProviderRefusedError'
    this.errorCodes = Object.freeze([...errorCodes])
  }
}

/**
 * Verificación del captcha del formulario público. `verify` devuelve `false` si el token no vale
 * (403), lanza `CaptchaProviderRefusedError` si el proveedor rechaza la verificación por un motivo que
 * no es el token (503 `SERVICE_UNAVAILABLE`) y lanza cualquier otro error si el proveedor no responde
 * o responde algo ilegible (503 `CAPTCHA_UNAVAILABLE`). Nunca deja pasar sin verificar.
 */
export interface CaptchaVerifierPort {
  verify(input: CaptchaVerificationInput): Promise<boolean>
}

export const CAPTCHA_VERIFIER = Symbol('CAPTCHA_VERIFIER')
