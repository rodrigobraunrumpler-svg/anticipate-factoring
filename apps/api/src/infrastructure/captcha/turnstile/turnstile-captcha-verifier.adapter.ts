import { z } from 'zod'
import type {
  CaptchaVerificationInput,
  CaptchaVerifierPort,
} from '#/common/captcha/captcha-verifier.port.js'

/** Endpoint de verificación de Cloudflare Turnstile. */
export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/** Tope de espera de siteverify: pasado este tiempo, el envío recibe 503 `CAPTCHA_UNAVAILABLE`. */
const SITEVERIFY_TIMEOUT_MS = 5_000

/** Cloudflare emite tokens de hasta 2048 caracteres; uno más largo no puede ser válido. */
const MAX_TOKEN_LENGTH = 2048

const siteverifyResponseSchema = z.object({
  success: z.boolean(),
  hostname: z.string().optional(),
})

export type TurnstileOptions = {
  secretKey: string
  /** Si está, un token emitido para otro sitio se rechaza. */
  expectedHostname: string | undefined
}

/**
 * `CaptchaVerifierPort` con Cloudflare Turnstile. Manda la `Idempotency-Key` del envío como
 * `idempotency_key`: si Cloudflare acepta revalidar el mismo token con la misma clave, un reintento
 * con el token viejo tampoco recibe 403 (la landing igual pide un token nuevo en cada reintento).
 * Lanza si Cloudflare no responde, responde con error o devuelve algo ilegible.
 */
export class TurnstileCaptchaVerifier implements CaptchaVerifierPort {
  constructor(
    private readonly options: TurnstileOptions,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  async verify({ token, remoteIp, idempotencyKey }: CaptchaVerificationInput): Promise<boolean> {
    if (token === '' || token.length > MAX_TOKEN_LENGTH) return false
    const response = await this.fetchImpl(TURNSTILE_SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        secret: this.options.secretKey,
        response: token,
        remoteip: remoteIp,
        ...(idempotencyKey === undefined ? {} : { idempotency_key: idempotencyKey }),
      }),
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`Turnstile respondió ${response.status}`)
    const parsed = siteverifyResponseSchema.safeParse(await response.json())
    if (!parsed.success) throw new Error('Turnstile devolvió una respuesta ilegible')
    if (!parsed.data.success) return false
    const { expectedHostname } = this.options
    return expectedHostname === undefined || parsed.data.hostname === expectedHostname
  }
}
