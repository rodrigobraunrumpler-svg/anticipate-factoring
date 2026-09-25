import { z } from 'zod'
import { integer, postgresTarget, postgresUrl } from './env-values.js'

/**
 * Los tiempos que la migración `integrity` fija en la base con `ALTER DATABASE SET` (no en el pool:
 * el pooler de Neon rechaza esos parámetros al conectar). Viven aquí para que la configuración
 * compruebe que una transacción de la API termina antes de que la base la corte.
 */
export const DATABASE_SERVER_TIMEOUTS_MS = {
  statement: 15_000,
  lock: 5_000,
  idleInTransaction: 30_000,
} as const

/**
 * PostgreSQL. `DATABASE_URL` es la de la app (la del pooler en producción). `DATABASE_DIRECT_URL` y
 * `SHADOW_DATABASE_URL` solo las lee la CLI de Prisma (`prisma.config.ts`); se validan aquí para que
 * un valor mal escrito se note al arrancar y para que `.env.example` las declare.
 */
export const databaseShape = {
  DATABASE_URL: postgresUrl,
  DATABASE_DIRECT_URL: postgresUrl.optional(),
  SHADOW_DATABASE_URL: postgresUrl.optional(),
  DATABASE_POOL_MAX: integer({ fallback: 10, min: 1, max: 100 }),
  DATABASE_CONNECTION_TIMEOUT_MS: integer({ fallback: 5_000, min: 100, max: 60_000 }),
  DATABASE_IDLE_TIMEOUT_MS: integer({ fallback: 30_000, min: 1_000, max: 3_600_000 }),
  DATABASE_TRANSACTION_TIMEOUT_MS: integer({ fallback: 15_000, min: 1_000, max: 600_000 }),
  DATABASE_TRANSACTION_MAX_WAIT_MS: integer({ fallback: 5_000, min: 100, max: 60_000 }),
}

const databaseSchema = z.object(databaseShape)
export type DatabaseEnvironment = z.output<typeof databaseSchema>

function sameDatabase(first: string, second: string | undefined): boolean {
  if (second === undefined) return false
  const a = postgresTarget(first)
  const b = postgresTarget(second)
  return (
    a !== null && b !== null && a.host === b.host && a.port === b.port && a.database === b.database
  )
}

export function refineDatabase(env: DatabaseEnvironment, ctx: z.RefinementCtx): void {
  if (env.DATABASE_TRANSACTION_TIMEOUT_MS >= DATABASE_SERVER_TIMEOUTS_MS.idleInTransaction) {
    ctx.addIssue({
      code: 'custom',
      path: ['DATABASE_TRANSACTION_TIMEOUT_MS'],
      message: `debe ser menor que ${DATABASE_SERVER_TIMEOUTS_MS.idleInTransaction} (idle_in_transaction_session_timeout de la base)`,
    })
  }
  const shadow = env.SHADOW_DATABASE_URL
  if (
    shadow !== undefined &&
    (sameDatabase(shadow, env.DATABASE_URL) || sameDatabase(shadow, env.DATABASE_DIRECT_URL))
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['SHADOW_DATABASE_URL'],
      message:
        'debe apuntar a una base distinta de DATABASE_URL y DATABASE_DIRECT_URL: Prisma la vacía cada vez que la usa',
    })
  }
}

export function toDatabaseConfig(env: DatabaseEnvironment) {
  return {
    database: {
      url: env.DATABASE_URL,
      poolMax: env.DATABASE_POOL_MAX,
      connectionTimeoutMs: env.DATABASE_CONNECTION_TIMEOUT_MS,
      idleTimeoutMs: env.DATABASE_IDLE_TIMEOUT_MS,
      transactionTimeoutMs: env.DATABASE_TRANSACTION_TIMEOUT_MS,
      transactionMaxWaitMs: env.DATABASE_TRANSACTION_MAX_WAIT_MS,
    },
  }
}
