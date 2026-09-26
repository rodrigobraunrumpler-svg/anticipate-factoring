import { PrismaService } from '#/infrastructure/prisma/prisma.service.js'
import type {
  ClaimedOutboxEvent,
  OutboxClaim,
  OutboxEventRepositoryPort,
  OutboxFailureCode,
} from '#/modules/outbox/index.js'
import { type OutboxEventRow, toClaimedOutboxEvent } from './mappers/outbox-event-row.mapper.js'

/** Tope de cada conteo de `countBacklog`: acota el costo de la readiness con un backlog enorme. */
const BACKLOG_COUNT_CAP = 1000
/**
 * Largo de `outbox_events.provider_message_id` (`VARCHAR(255)` en el esquema y en la migración `init`):
 * se recorta a este largo para que un id más largo del proveedor nunca haga fallar `markPublished`.
 */
const PROVIDER_MESSAGE_ID_MAX_LENGTH = 255
/** Un evento cuyo último intento empezó y nunca informó su resultado (el proceso cayó con el arriendo tomado). */
const LAST_ATTEMPT_WITHOUT_RESULT: OutboxFailureCode = 'UNEXPECTED'

/**
 * El SQL del outbox. Los tiempos los pone la base (`now()`). Los predicados usan el literal del estado
 * (`status = 'PENDING'`), para que el planificador use los índices parciales (con un parámetro de enum
 * no los usa). Toda escritura de vuelta exige `id` y `lease_token`, y al salir de `PROCESSING` limpia
 * el arriendo. `attempts` cuenta intentos empezados (`startAttempt`), no reclamos: la CHECK
 * `attempts BETWEEN 0 AND max_attempts` impide además empezar uno de más.
 */
export class PrismaOutboxEventRepository implements OutboxEventRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  /** Reserva sin contar el intento: `attempts` del resultado es el número que tendrá al empezar. */
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
             lock_expires_at = now() + make_interval(secs => ${p.leaseSeconds}::int)
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
                o.lease_token AS "leaseToken", o.attempts + 1 AS attempts,
                o.max_attempts AS "maxAttempts"`
    return rows.map(toClaimedOutboxEvent)
  }

  /**
   * Cuenta el intento, renueva el arriendo y cambia el token: el del reclamo deja de servir (no se
   * empieza dos veces ni se devuelve un intento empezado) y las escrituras de vuelta usan el nuevo.
   * Extiende también un arriendo vencido que nadie retomó: el token sigue siendo de quien llama.
   */
  async startAttempt(p: {
    id: string
    leaseToken: string
    leaseSeconds: number
  }): Promise<string | null> {
    const [row] = await this.prisma.$queryRaw<{ leaseToken: string }[]>`
      UPDATE outbox_events
         SET attempts = attempts + 1,
             lease_token = gen_random_uuid(),
             locked_at = now(),
             lock_expires_at = now() + make_interval(secs => ${p.leaseSeconds}::int)
       WHERE id = ${p.id}::uuid AND lease_token = ${p.leaseToken}::uuid
      RETURNING lease_token AS "leaseToken"`
    return row?.leaseToken ?? null
  }

  /** `available_at` no cambia: lo devuelto sigue vencido y en su orden, listo para otro proceso. */
  releaseClaims(p: { claims: readonly OutboxClaim[] }): Promise<number> {
    if (p.claims.length === 0) return Promise.resolve(0)
    const ids = p.claims.map(({ id }) => id)
    const tokens = p.claims.map(({ leaseToken }) => leaseToken)
    return this.prisma.$executeRaw`
      UPDATE outbox_events AS o
         SET status = 'PENDING', lease_token = NULL, locked_at = NULL, lock_expires_at = NULL
        FROM unnest(${ids}::uuid[], ${tokens}::uuid[]) AS c(id, lease_token)
       WHERE o.id = c.id AND o.lease_token = c.lease_token`
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
