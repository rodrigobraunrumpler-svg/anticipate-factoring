import { z } from 'zod'
import { flag, integer } from './env-values.js'

/**
 * Publicador del outbox: sondeo, arriendo, reintentos con espera exponencial, tope por handler y
 * purga de los eventos `PUBLISHED`.
 */
export const outboxShape = {
  OUTBOX_POLLER_ENABLED: flag(true),
  OUTBOX_POLL_INTERVAL_MS: integer({ fallback: 5_000, min: 100, max: 3_600_000 }),
  OUTBOX_BATCH_SIZE: integer({ fallback: 20, min: 1, max: 1_000 }),
  OUTBOX_LEASE_SECONDS: integer({ fallback: 120, min: 1, max: 3_600 }),
  OUTBOX_BASE_DELAY_MS: integer({ fallback: 30_000, min: 1, max: 86_400_000 }),
  OUTBOX_MAX_DELAY_MS: integer({ fallback: 3_600_000, min: 1, max: 86_400_000 }),
  OUTBOX_MAX_ATTEMPTS: integer({ fallback: 8, min: 1, max: 100 }),
  OUTBOX_RETENTION_DAYS: integer({ fallback: 30, min: 1, max: 3_650 }),
  OUTBOX_PURGE_BATCH_SIZE: integer({ fallback: 500, min: 1, max: 10_000 }),
  OUTBOX_HANDLER_TIMEOUT_MS: integer({ fallback: 20_000, min: 1, max: 600_000 }),
}

const outboxSchema = z.object(outboxShape)
export type OutboxEnvironment = z.output<typeof outboxSchema>

export function refineOutbox(env: OutboxEnvironment, ctx: z.RefinementCtx): void {
  // El arriendo se renueva al empezar cada intento y tiene que cubrir el tope del handler más la espera
  // a que termine tras el aviso, dejando OUTBOX_HANDLER_TIMEOUT_MS para escribir el resultado.
  if (env.OUTBOX_HANDLER_TIMEOUT_MS * 2 >= env.OUTBOX_LEASE_SECONDS * 1000) {
    ctx.addIssue({
      code: 'custom',
      path: ['OUTBOX_HANDLER_TIMEOUT_MS'],
      message: 'el doble debe ser menor que OUTBOX_LEASE_SECONDS (en milisegundos)',
    })
  }
}

export function toOutboxConfig(env: OutboxEnvironment) {
  return {
    outbox: {
      pollerEnabled: env.OUTBOX_POLLER_ENABLED,
      pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
      batchSize: env.OUTBOX_BATCH_SIZE,
      leaseSeconds: env.OUTBOX_LEASE_SECONDS,
      baseDelayMs: env.OUTBOX_BASE_DELAY_MS,
      maxDelayMs: env.OUTBOX_MAX_DELAY_MS,
      maxAttempts: env.OUTBOX_MAX_ATTEMPTS,
      retentionDays: env.OUTBOX_RETENTION_DAYS,
      purgeBatchSize: env.OUTBOX_PURGE_BATCH_SIZE,
      handlerTimeoutMs: env.OUTBOX_HANDLER_TIMEOUT_MS,
    },
  }
}
