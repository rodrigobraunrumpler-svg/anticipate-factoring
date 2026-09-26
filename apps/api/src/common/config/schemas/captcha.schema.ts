import { z } from 'zod'
import { requiredText } from './env-values.js'
import type { HttpEnvironment } from './http.schema.js'
import type { RuntimeEnvironment } from './runtime.schema.js'

/**
 * Claves secretas de prueba de Cloudflare Turnstile: siempre aprueba, siempre rechaza y token ya
 * usado. Sirven en local y en tests; en producción dejarían pasar (o frenar) a todo el mundo.
 */
export const TURNSTILE_TEST_SECRET_KEYS = [
  '1x0000000000000000000000000000000AA',
  '2x0000000000000000000000000000000AA',
  '3x0000000000000000000000000000000AA',
] as const

/** Captcha del formulario público (Cloudflare Turnstile). */
export const captchaShape = {
  TURNSTILE_SECRET_KEY: requiredText,
  // Cloudflare devuelve el host en minúsculas y el adaptador lo compara exacto: `Anticipate.pe`
  // rechazaría cada token.
  TURNSTILE_EXPECTED_HOSTNAME: requiredText
    .regex(/^[a-z0-9.-]+$/i, {
      error: 'debe ser un nombre de host sin esquema ni ruta (anticipate.pe)',
    })
    .transform((hostname) => hostname.toLowerCase())
    .optional(),
}

const captchaSchema = z.object(captchaShape)
export type CaptchaEnvironment = z.output<typeof captchaSchema>

export function refineCaptcha(
  env: CaptchaEnvironment &
    Pick<RuntimeEnvironment, 'NODE_ENV'> &
    Pick<HttpEnvironment, 'CORS_ORIGINS'>,
  ctx: z.RefinementCtx,
): void {
  if (env.NODE_ENV !== 'production') return
  const isTestKey = (TURNSTILE_TEST_SECRET_KEYS as readonly string[]).includes(
    env.TURNSTILE_SECRET_KEY,
  )
  if (isTestKey) {
    ctx.addIssue({
      code: 'custom',
      path: ['TURNSTILE_SECRET_KEY'],
      message:
        'es una clave de prueba de Cloudflare: en producción usa la clave secreta del panel de Turnstile',
    })
  }
  // El widget corre en la página que envía el formulario: el host del token es el de su origen. Otro
  // host es un error de configuración que rechazaría cada envío con 403 (solo con un aviso en el log).
  const expected = env.TURNSTILE_EXPECTED_HOSTNAME
  const originHosts = env.CORS_ORIGINS?.map((origin) => new URL(origin).hostname)
  if (expected !== undefined && originHosts !== undefined && !originHosts.includes(expected)) {
    ctx.addIssue({
      code: 'custom',
      path: ['TURNSTILE_EXPECTED_HOSTNAME'],
      message:
        'debe ser el host de uno de los CORS_ORIGINS (el de la landing): el widget corre en la página que envía el formulario, y con otro host cada envío recibe 403',
    })
  }
}

export function toCaptchaConfig(env: CaptchaEnvironment) {
  return {
    turnstile: {
      secretKey: env.TURNSTILE_SECRET_KEY,
      expectedHostname: env.TURNSTILE_EXPECTED_HOSTNAME,
    },
  }
}
