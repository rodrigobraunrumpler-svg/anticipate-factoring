/** Lo que recibe el verificador: el token del navegador, la IP del cliente y la clave del envío. */
export type CaptchaVerificationInput = {
  token: string
  remoteIp: string
  /** `Idempotency-Key` del envío, solo si es un UUID válido: permite revalidar en un reintento. */
  idempotencyKey?: string
}

/**
 * Verificación del captcha del formulario público. `verify` devuelve `false` si el token no vale y
 * lanza si el proveedor no responde: la API contesta 503 y nunca deja pasar sin verificar.
 */
export interface CaptchaVerifierPort {
  verify(input: CaptchaVerificationInput): Promise<boolean>
}

export const CAPTCHA_VERIFIER = Symbol('CAPTCHA_VERIFIER')
