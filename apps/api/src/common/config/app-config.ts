import { ENVIRONMENT_KEYS, type Environment, environmentSchema } from './environment.schema.js'
import { toCaptchaConfig } from './schemas/captcha.schema.js'
import { toDatabaseConfig } from './schemas/database.schema.js'
import { toHttpConfig } from './schemas/http.schema.js'
import { toMailConfig } from './schemas/mail.schema.js'
import { toMaintenanceConfig } from './schemas/maintenance.schema.js'
import { toOutboxConfig } from './schemas/outbox.schema.js'
import { toRuntimeConfig } from './schemas/runtime.schema.js'
import { toStorageConfig } from './schemas/storage.schema.js'
import { toThrottleConfig } from './schemas/throttle.schema.js'
import { toUploadConfig } from './schemas/upload.schema.js'

/** Token de la configuración validada. Lo provee `AppConfigModule.register(config)`, global. */
export const APP_CONFIG = Symbol('APP_CONFIG')

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T

function toAppConfig(env: Environment) {
  return {
    ...toRuntimeConfig(env),
    ...toHttpConfig(env),
    ...toDatabaseConfig(env),
    ...toStorageConfig(env),
    ...toMailConfig(env),
    ...toCaptchaConfig(env),
    ...toUploadConfig(env),
    ...toThrottleConfig(env),
    ...toOutboxConfig(env),
    ...toMaintenanceConfig(env),
  }
}

/** La configuración de la API, validada y congelada: nadie la cambia después de arrancar. */
export type AppConfig = DeepReadonly<ReturnType<typeof toAppConfig>>

/** Configuración inválida. Su mensaje enumera cada variable con su problema y nunca repite un valor. */
export class ConfigValidationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Configuración inválida:\n${problems.map((problem) => `- ${problem}`).join('\n')}`)
    this.name = 'ConfigValidationError'
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value)) deepFreeze(nested)
  }
  return value
}

/**
 * Valida el entorno. Solo mira las variables que declara el esquema, y una variable vacía cuenta como
 * ausente. Si algo falta o es inválido, lanza `ConfigValidationError` con todos los problemas juntos
 * y la API no arranca.
 */
export function parseConfig(raw: Readonly<Record<string, string | undefined>>): AppConfig {
  const known = new Set<string>(ENVIRONMENT_KEYS)
  const present = Object.fromEntries(
    Object.entries(raw).filter(
      (entry): entry is [string, string] =>
        known.has(entry[0]) && entry[1] !== undefined && entry[1].trim() !== '',
    ),
  )
  const result = environmentSchema.safeParse(present)
  if (!result.success) {
    throw new ConfigValidationError(
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    )
  }
  return deepFreeze(toAppConfig(result.data))
}
