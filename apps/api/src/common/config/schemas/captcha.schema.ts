import { z } from 'zod'
import { requiredText } from './env-values.js'
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
  TURNSTILE_EXPECTED_HOSTNAME: requiredText
    .regex(/^[a-z0-9.-]+$/i, {
      error: 'debe ser un nombre de host sin esquema ni ruta (anticipate.pe)',
    })
    .optional(),
}

const captchaSchema = z.object(captchaShape)
export type CaptchaEnvironment = z.output<typeof captchaSchema>

export function refineCaptcha(
  env: CaptchaEnvironment & Pick<RuntimeEnvironment, 'NODE_ENV'>,
  ctx: z.RefinementCtx,
): void {
  const isTestKey = (TURNSTILE_TEST_SECRET_KEYS as readonly string[]).includes(
    env.TURNSTILE_SECRET_KEY,
  )
  if (env.NODE_ENV === 'production' && isTestKey) {
    ctx.addIssue({
      code: 'custom',
      path: ['TURNSTILE_SECRET_KEY'],
      message:
        'es una clave de prueba de Cloudflare: en producción usa la clave secreta del panel de Turnstile',
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
