import { z } from 'zod'
import { integer } from './env-values.js'

/**
 * Límites de peticiones por IP: `default` para toda la API y `submit` solo para las rutas con
 * `@SubmitThrottle()` (el envío de solicitudes). Cloudflare aplica además su propia regla.
 */
export const throttleShape = {
  THROTTLE_DEFAULT_LIMIT: integer({ fallback: 120, min: 1, max: 100_000 }),
  THROTTLE_DEFAULT_TTL_SECONDS: integer({ fallback: 60, min: 1, max: 86_400 }),
  THROTTLE_SUBMIT_LIMIT: integer({ fallback: 5, min: 1, max: 100_000 }),
  THROTTLE_SUBMIT_TTL_SECONDS: integer({ fallback: 3_600, min: 1, max: 86_400 }),
}

const throttleSchema = z.object(throttleShape)
export type ThrottleEnvironment = z.output<typeof throttleSchema>

export function toThrottleConfig(env: ThrottleEnvironment) {
  return {
    throttle: {
      defaultLimit: env.THROTTLE_DEFAULT_LIMIT,
      defaultTtlMs: env.THROTTLE_DEFAULT_TTL_SECONDS * 1000,
      submitLimit: env.THROTTLE_SUBMIT_LIMIT,
      submitTtlMs: env.THROTTLE_SUBMIT_TTL_SECONDS * 1000,
    },
  }
}
