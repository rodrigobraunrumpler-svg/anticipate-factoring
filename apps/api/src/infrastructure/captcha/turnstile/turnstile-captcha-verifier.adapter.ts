import { Logger } from '@nestjs/common'
import { z } from 'zod'
import {
  CaptchaProviderRefusedError,
  type CaptchaVerificationInput,
  type CaptchaVerifierPort,
} from '#/common/captcha/captcha-verifier.port.js'

/** Endpoint de verificación de Cloudflare Turnstile. */
export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/** Tope de espera de siteverify: pasado este tiempo, el envío recibe 503 `CAPTCHA_UNAVAILABLE`. */
const SITEVERIFY_TIMEOUT_MS = 5_000

/** Cloudflare emite tokens de hasta 2048 caracteres; uno más largo no puede ser válido. */
const MAX_TOKEN_LENGTH = 2048

/**
 * Códigos de siteverify que dicen que el problema es el token del visitante: falta, no vale, venció
 * o ya se usó. Son los únicos que responden 403. Cualquier otro (`missing-input-secret`,
 * `invalid-input-secret`, `invalid-widget-id`, `invalid-parsed-secret`, `bad-request`,
 * `internal-error` o uno que Cloudflare agregue) es un problema de la configuración o del proveedor:
 * rechazaría a todos los visitantes, así que responde 503 y queda en el log.
 */
const TOKEN_ERROR_CODES: ReadonlySet<string> = new Set([
  'missing-input-response',
  'invalid-input-response',
  'timeout-or-duplicate',
])

/** Forma de un código de Cloudflare; lo que no la cumple no se copia al log tal cual. */
const ERROR_CODE_FORMAT = /^[a-z0-9-]{1,64}$/
const UNREADABLE_ERROR_CODE = 'codigo-ilegible'
const MAX_LOGGED_ERROR_CODES = 10

const siteverifyResponseSchema = z.object({
  success: z.boolean(),
  hostname: z.string().optional(),
  'error-codes': z.array(z.unknown()).optional(),
})

export type TurnstileOptions = {
  secretKey: string
  /** Si está, un token emitido para otro sitio se rechaza. */
  expectedHostname: string | undefined
}

/** Los códigos que devolvió Cloudflare, acotados en cantidad y forma para escribirlos en el log. */
function boundedErrorCodes(codes: readonly unknown[]): string[] {
  return codes
    .slice(0, MAX_LOGGED_ERROR_CODES)
    .map((code) =>
      typeof code === 'string' && ERROR_CODE_FORMAT.test(code) ? code : UNREADABLE_ERROR_CODE,
    )
}

/**
 * `CaptchaVerifierPort` con Cloudflare Turnstile. Manda la `Idempotency-Key` del envío como
 * `idempotency_key`: si Cloudflare acepta revalidar el mismo token con la misma clave, un reintento
 * con el token viejo tampoco recibe 403 (la landing igual pide un token nuevo en cada reintento).
 *
 * - Token rechazado (solo códigos de `TOKEN_ERROR_CODES`) o de otro hostname: `false`.
 * - Cloudflare se niega a verificar por otro motivo (clave secreta equivocada o rotada, petición mal
 *   formada, error interno, un código nuevo o ninguno): registra los códigos con nivel error y lanza
 *   `CaptchaProviderRefusedError`. Nunca registra el token, el secreto ni la IP.
 * - Cloudflare no responde, responde con un estado de error o algo ilegible: lanza.
 */
export class TurnstileCaptchaVerifier implements CaptchaVerifierPort {
  private readonly logger = new Logger(TurnstileCaptchaVerifier.name)

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
    const { success, hostname } = parsed.data
    if (!success) return this.rejected(parsed.data['error-codes'] ?? [])
    const { expectedHostname } = this.options
    if (expectedHostname === undefined || hostname === expectedHostname) return true
    // Un token resuelto en otro sitio, o un TURNSTILE_EXPECTED_HOSTNAME equivocado: el aviso lo
    // distingue sin exponer el token.
    this.logger.warn(
      { hostname: hostname?.slice(0, 253) ?? null, expectedHostname },
      'Turnstile: token emitido para otro hostname; se rechaza',
    )
    return false
  }

  /** `false` si el problema es el token; si no, lo registra y lanza `CaptchaProviderRefusedError`. */
  private rejected(codes: readonly unknown[]): false {
    if (
      codes.length > 0 &&
      codes.every((code) => typeof code === 'string' && TOKEN_ERROR_CODES.has(code))
    ) {
      return false
    }
    const errorCodes = boundedErrorCodes(codes)
    this.logger.error(
      { errorCodes },
      'Turnstile: siteverify se negó a verificar por un motivo que no es el token (revisa TURNSTILE_SECRET_KEY); se responde 503',
    )
    throw new CaptchaProviderRefusedError(errorCodes)
  }
}
