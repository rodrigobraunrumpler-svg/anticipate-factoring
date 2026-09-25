import { formatPublicCode, parsePublicCode } from '@anticipate/shared/advance-request'
import { z } from 'zod'
import { integer, requiredText } from './env-values.js'

export const NODE_ENVIRONMENTS = ['development', 'test', 'production'] as const
export type NodeEnvironment = (typeof NODE_ENVIRONMENTS)[number]

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

/**
 * El prefijo tiene que producir códigos que `shared` acepta: la landing, el admin y la CHECK de la
 * base validan `public_code` con la misma regla, así que se comprueba con ella y no con una copia.
 */
function isValidPublicCodePrefix(prefix: string): boolean {
  return parsePublicCode(formatPublicCode({ prefix, year: 2026, sequence: 1 }))?.prefix === prefix
}

/** Identidad del proceso: modo, puerto, nivel de log y prefijo de los códigos públicos. */
export const runtimeShape = {
  // Sin valor por defecto: un despliegue sin NODE_ENV correría como desarrollo y se saltaría las
  // guardas de producción.
  NODE_ENV: z.enum(NODE_ENVIRONMENTS, { error: 'debe ser development, test o production' }),
  PORT: integer({ fallback: 4000, min: 1, max: 65_535 }),
  LOG_LEVEL: z
    .enum(LOG_LEVELS, { error: 'debe ser fatal, error, warn, info, debug, trace o silent' })
    .default('info'),
  PUBLIC_CODE_PREFIX: requiredText
    .refine(isValidPublicCodePrefix, { error: 'debe tener de 2 a 6 letras mayúsculas (A-Z)' })
    .default('ANT'),
}

const runtimeSchema = z.object(runtimeShape)
export type RuntimeEnvironment = z.output<typeof runtimeSchema>

export function toRuntimeConfig(env: RuntimeEnvironment) {
  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    publicCodePrefix: env.PUBLIC_CODE_PREFIX,
  }
}
