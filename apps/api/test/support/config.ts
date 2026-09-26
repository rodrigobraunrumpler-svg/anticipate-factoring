import { inject } from 'vitest'
import {
  type AppConfig,
  ENVIRONMENT_KEYS,
  type EnvironmentKey,
  parseConfig,
} from '#/common/config/index.js'

declare module 'vitest' {
  export interface ProvidedContext {
    /** Variables de `apps/api/.env.test` (`test/integration/global-setup.ts`). Solo en `api:integration`. */
    testContainerEnv?: Readonly<Record<string, string>>
  }
}

/**
 * Entorno de prueba completo: TODAS las variables del esquema, escritas a mano (el `satisfies` hace
 * que olvidar una no compile). Nunca arranca el publicador del outbox ni el mantenimiento, el correo
 * es `fake` y los logs están apagados.
 */
export const TEST_ENV_DEFAULTS = {
  NODE_ENV: 'test',
  PORT: '4000',
  LOG_LEVEL: 'silent',
  PUBLIC_CODE_PREFIX: 'ANT',
  CORS_ORIGINS: 'http://localhost:4321,http://localhost:3000',
  TRUST_PROXY: 'loopback',
  TRUST_CLOUDFLARE_HEADERS: 'false',
  SERVER_REQUEST_TIMEOUT_MS: '120000',
  SERVER_HEADERS_TIMEOUT_MS: '20000',
  SERVER_KEEP_ALIVE_TIMEOUT_MS: '65000',
  DATABASE_URL: 'postgresql://anticipate:anticipate@127.0.0.1:5432/anticipate_test',
  DATABASE_DIRECT_URL: 'postgresql://anticipate:anticipate@127.0.0.1:5432/anticipate_test',
  SHADOW_DATABASE_URL: 'postgresql://anticipate:anticipate@127.0.0.1:5432/anticipate_shadow',
  DATABASE_POOL_MAX: '10',
  DATABASE_CONNECTION_TIMEOUT_MS: '5000',
  DATABASE_IDLE_TIMEOUT_MS: '30000',
  DATABASE_TRANSACTION_TIMEOUT_MS: '15000',
  DATABASE_TRANSACTION_MAX_WAIT_MS: '5000',
  S3_ENDPOINT: 'http://127.0.0.1:9090',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'anticipate-local',
  S3_ACCESS_KEY_ID: 'local',
  S3_SECRET_ACCESS_KEY: 'local',
  S3_FORCE_PATH_STYLE: 'true',
  STORAGE_ORPHAN_GRACE_MINUTES: '60',
  STORAGE_DELETE_DELAY_DAYS: '35',
  MAIL_TRANSPORT: 'fake',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '1025',
  BREVO_API_KEY: '',
  MAIL_FROM_EMAIL: 'solicitudes@anticipate.local',
  MAIL_FROM_NAME: 'Anticipate',
  TEAM_NOTIFICATION_EMAIL: 'equipo@anticipate.local',
  ADMIN_BASE_URL: 'http://localhost:3000',
  TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
  TURNSTILE_EXPECTED_HOSTNAME: '',
  UPLOAD_MAX_BODY_BYTES: '95000000',
  UPLOAD_MAX_INFLIGHT_BYTES: '190000000',
  UPLOAD_MAX_PDF_BYTES: '10485760',
  UPLOAD_MAX_XML_BYTES: '1048576',
  UPLOAD_MAX_FILES: '20',
  XML_PARSE_WORKERS: '2',
  XML_PARSE_TIMEOUT_MS: '2000',
  XML_PARSE_WORKER_HEAP_MB: '128',
  XML_PARSE_QUEUE_LIMIT: '32',
  XML_PARSE_QUEUE_TIMEOUT_MS: '10000',
  THROTTLE_DEFAULT_LIMIT: '1000',
  THROTTLE_DEFAULT_TTL_SECONDS: '60',
  THROTTLE_SUBMIT_LIMIT: '1000',
  THROTTLE_SUBMIT_TTL_SECONDS: '3600',
  OUTBOX_POLLER_ENABLED: 'false',
  OUTBOX_POLL_INTERVAL_MS: '5000',
  OUTBOX_BATCH_SIZE: '20',
  OUTBOX_LEASE_SECONDS: '120',
  OUTBOX_BASE_DELAY_MS: '30000',
  OUTBOX_MAX_DELAY_MS: '3600000',
  OUTBOX_MAX_ATTEMPTS: '8',
  OUTBOX_RETENTION_DAYS: '30',
  OUTBOX_PURGE_BATCH_SIZE: '500',
  OUTBOX_HANDLER_TIMEOUT_MS: '20000',
  MAINTENANCE_ENABLED: 'false',
  MAINTENANCE_INTERVAL_MS: '3600000',
  SUBMISSION_TIMEOUT_MS: '60000',
  SHUTDOWN_TIMEOUT_MS: '25000',
} as const satisfies Record<EnvironmentKey, string>

/**
 * Variables de `apps/api/.env.test` que dejó `test/integration/global-setup.ts` (URLs de la base, S3,
 * SMTP y Mailpit de esta máquina). En los tests unitarios no hay: devuelve un objeto vacío.
 */
export function testContainerEnv(): Readonly<Record<string, string>> {
  return inject('testContainerEnv') ?? {}
}

/** Los tests truncan tablas: nunca corren contra una base que no termine en `_test`. */
function assertTestDatabase(env: Readonly<Record<string, string | undefined>>): void {
  for (const key of ['DATABASE_URL', 'DATABASE_DIRECT_URL'] as const) {
    const value = env[key]
    if (value === undefined || value.trim() === '') continue
    let database = ''
    try {
      database = decodeURIComponent(new URL(value).pathname.slice(1))
    } catch {
      // Una URL rota la rechaza parseConfig con su propio mensaje.
      continue
    }
    if (!database.endsWith('_test')) {
      throw new Error(
        `${key} apunta a la base «${database}»: los tests solo corren contra una base que termine en _test.`,
      )
    }
  }
}

/** Entorno de prueba: los valores de arriba, lo que venga de los contenedores y las sobreescrituras. */
export function testEnv(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  const containers = testContainerEnv()
  const fromContainers: Record<string, string> = {}
  for (const key of ENVIRONMENT_KEYS) {
    const value = containers[key]
    if (value !== undefined && value.trim() !== '') fromContainers[key] = value
  }
  const env = { ...TEST_ENV_DEFAULTS, ...fromContainers, ...overrides }
  assertTestDatabase(env)
  return env
}

export function testConfig(
  overrides: Readonly<Record<string, string | undefined>> = {},
): AppConfig {
  return parseConfig(testEnv(overrides))
}
