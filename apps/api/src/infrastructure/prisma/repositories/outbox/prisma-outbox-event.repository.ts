import { PrismaService } from '#/infrastructure/prisma/prisma.service.js'
import type {
  ClaimedOutboxEvent,
  OutboxEventRepositoryPort,
  OutboxFailureCode,
} from '#/modules/outbox/index.js'
import { type OutboxEventRow, toClaimedOutboxEvent } from './mappers/outbox-event-row.mapper.js'

/** Tope de cada conteo de `countBacklog`: acota el costo de la readiness con un backlog enorme. */
const BACKLOG_COUNT_CAP = 1000
/** Largo de `outbox_events.provider_message_id`. */
const PROVIDER_MESSAGE_ID_MAX_LENGTH = 200
/** Un evento cuyo último intento nunca informó su resultado (el proceso cayó con el arriendo tomado). */
const LAST_ATTEMPT_WITHOUT_RESULT: OutboxFailureCode = 'UNEXPECTED'

/**
 * El SQL del outbox. Los tiempos los pone la base (`now()`). Los predicados usan el literal del estado
 * (`status = 'PENDING'`), para que el planificador use los índices parciales (con un parámetro de enum
 * no los usa). Toda escritura de vuelta exige `id` y `lease_token`, y al salir de `PROCESSING` limpia
 * el arriendo.
 */
export class PrismaOutboxEventRepository implements OutboxEventRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async claimDue(p: {
    handlers: readonly string[]
    leaseSeconds: number
    batchSize: number
  }): Promise<ClaimedOutboxEvent[]> {
    if (p.handlers.length === 0) return []
    const rows = await this.prisma.$queryRaw<OutboxEventRow[]>`
      UPDATE outbox_events AS o
         SET status = 'PROCESSING',
             lease_token = gen_random_uuid(),
             locked_at = now(),
             lock_expires_at = now() + make_interval(secs => ${p.leaseSeconds}::int),
             attempts = o.attempts + 1
       WHERE o.id IN (
             SELECT id FROM outbox_events
              WHERE handler = ANY(${[...p.handlers]}::text[])
                AND attempts < max_attempts
                AND ((status = 'PENDING' AND available_at <= now())
                  OR (status = 'PROCESSING' AND lock_expires_at <= now()))
              ORDER BY available_at
              LIMIT ${p.batchSize}::int
                FOR UPDATE SKIP LOCKED)
      RETURNING o.id, o.handler, o.dedupe_key AS "dedupeKey", o.event_type AS "eventType", o.payload,
                o.advance_request_id AS "advanceRequestId", o.correlation_id AS "correlationId",
                o.lease_token AS "leaseToken", o.attempts, o.max_attempts AS "maxAttempts"`
    return rows.map(toClaimedOutboxEvent)
  }

  async renewLease(p: { id: string; leaseToken: string; leaseSeconds: number }): Promise<boolean> {
    const updated = await this.prisma.$executeRaw`
      UPDATE outbox_events
         SET lock_expires_at = now() + make_interval(secs => ${p.leaseSeconds}::int)
       WHERE id = ${p.id}::uuid AND lease_token = ${p.leaseToken}::uuid`
    return updated === 1
  }

  async markPublished(p: {
    id: string
    leaseToken: string
    providerMessageId: string | null
  }): Promise<boolean> {
    const providerMessageId = p.providerMessageId?.slice(0, PROVIDER_MESSAGE_ID_MAX_LENGTH) ?? null
    const updated = await this.prisma.$executeRaw`
      UPDATE outbox_events
         SET status = 'PUBLISHED', published_at = now(), provider_message_id = ${providerMessageId},
             lease_token = NULL, locked_at = NULL, lock_expires_at = NULL
       WHERE id = ${p.id}::uuid AND lease_token = ${p.leaseToken}::uuid`
    return updated === 1
  }

  async reschedule(p: {
    id: string
    leaseToken: string
    delaySeconds: number
    failureCode: OutboxFailureCode
  }): Promise<boolean> {
    const updated = await this.prisma.$executeRaw`
      UPDATE outbox_events
         SET status = 'PENDING',
             available_at = now() + make_interval(secs => ${p.delaySeconds}::int),
             last_error = ${p.failureCode},
             lease_token = NULL, locked_at = NULL, lock_expires_at = NULL
       WHERE id = ${p.id}::uuid AND lease_token = ${p.leaseToken}::uuid`
    return updated === 1
  }

  async markDeadLetter(p: {
    id: string
    leaseToken: string
    failureCode: OutboxFailureCode
  }): Promise<boolean> {
    const updated = await this.prisma.$executeRaw`
      UPDATE outbox_events
         SET status = 'DEAD_LETTER', last_error = ${p.failureCode},
             lease_token = NULL, locked_at = NULL, lock_expires_at = NULL
       WHERE id = ${p.id}::uuid AND lease_token = ${p.leaseToken}::uuid`
    return updated === 1
  }

  deadLetterExhausted(): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE outbox_events
         SET status = 'DEAD_LETTER',
             last_error = CASE WHEN status = 'PROCESSING' THEN ${LAST_ATTEMPT_WITHOUT_RESULT}
                               ELSE coalesce(last_error, ${LAST_ATTEMPT_WITHOUT_RESULT}) END,
             lease_token = NULL, locked_at = NULL, lock_expires_at = NULL
       WHERE attempts >= max_attempts
         AND (status = 'PENDING' OR (status = 'PROCESSING' AND lock_expires_at <= now()))`
  }

  purgePublished(p: { olderThanDays: number; batchSize: number }): Promise<number> {
    return this.prisma.$executeRaw`
      DELETE FROM outbox_events
       WHERE id IN (
             SELECT id FROM outbox_events
              WHERE id < uuidv7_floor(now() - make_interval(days => ${p.olderThanDays}::int))
                AND status = 'PUBLISHED'
              ORDER BY id
              LIMIT ${p.batchSize}::int)`
  }

  async countBacklog(p: {
    lateAfterSeconds: number
  }): Promise<{ deadLetter: number; late: number }> {
    const [row] = await this.prisma.$queryRaw<{ deadLetter: number; late: number }[]>`
      SELECT
        (SELECT count(*) FROM (
           SELECT 1 FROM outbox_events WHERE status = 'DEAD_LETTER' LIMIT ${BACKLOG_COUNT_CAP}::int) AS d
        )::int AS "deadLetter",
        ((SELECT count(*) FROM (
            SELECT 1 FROM outbox_events
             WHERE status = 'PENDING'
               AND available_at <= now() - make_interval(secs => ${p.lateAfterSeconds}::int)
             LIMIT ${BACKLOG_COUNT_CAP}::int) AS pending)
         + (SELECT count(*) FROM (
            SELECT 1 FROM outbox_events
             WHERE status = 'PROCESSING'
               AND lock_expires_at <= now() - make_interval(secs => ${p.lateAfterSeconds}::int)
             LIMIT ${BACKLOG_COUNT_CAP}::int) AS processing)
        )::int AS "late"`
    return { deadLetter: row?.deadLetter ?? 0, late: row?.late ?? 0 }
  }

  async millisecondsUntilNextDue(p: { handlers: readonly string[] }): Promise<number | null> {
    if (p.handlers.length === 0) return null
    const handlers = [...p.handlers]
    const [row] = await this.prisma.$queryRaw<{ ms: number | null }[]>`
      SELECT (extract(epoch FROM least(
               (SELECT min(available_at) FROM outbox_events
                 WHERE status = 'PENDING' AND handler = ANY(${handlers}::text[])),
               (SELECT min(lock_expires_at) FROM outbox_events
                 WHERE status = 'PROCESSING' AND handler = ANY(${handlers}::text[]))
             ) - now()) * 1000)::float8 AS ms`
    return row?.ms ?? null
  }
}
