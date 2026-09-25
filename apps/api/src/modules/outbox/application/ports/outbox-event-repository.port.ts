import type { OutboxFailureCode } from '../../domain/exceptions/outbox-failure-code.js'
import type { ClaimedOutboxEvent } from '../../domain/types/outbox-event.types.js'

/**
 * Persistencia del outbox. Todos los tiempos los pone la base (`now()`). Toda escritura de vuelta
 * exige `id` y `leaseToken`, y devuelve `false` si el arriendo ya no es de quien escribe (otro proceso
 * retomó el evento): ese resultado se descarta.
 */
export interface OutboxEventRepositoryPort {
  /** Una sola sentencia con `FOR UPDATE SKIP LOCKED`: solo `handlers`, `attempts < max_attempts`, pendientes vencidos o arriendos vencidos. */
  claimDue(p: {
    handlers: readonly string[]
    leaseSeconds: number
    batchSize: number
  }): Promise<ClaimedOutboxEvent[]>
  renewLease(p: { id: string; leaseToken: string; leaseSeconds: number }): Promise<boolean>
  markPublished(p: {
    id: string
    leaseToken: string
    providerMessageId: string | null
  }): Promise<boolean>
  reschedule(p: {
    id: string
    leaseToken: string
    delaySeconds: number
    failureCode: OutboxFailureCode
  }): Promise<boolean>
  markDeadLetter(p: {
    id: string
    leaseToken: string
    failureCode: OutboxFailureCode
  }): Promise<boolean>
  /** Pasa a `DEAD_LETTER` los eventos sin intentos restantes (pendientes, o en proceso con el arriendo vencido). */
  deadLetterExhausted(): Promise<number>
  /** Un lote de `DELETE` por rango de PK: `id < uuidv7_floor(now() - días) AND status = 'PUBLISHED'`. */
  purgePublished(p: { olderThanDays: number; batchSize: number }): Promise<number>
  /** Eventos en `DEAD_LETTER` y atrasados más de `lateAfterSeconds`. Cada conteo tiene un tope (la readiness solo necesita saber si hay). */
  countBacklog(p: { lateAfterSeconds: number }): Promise<{ deadLetter: number; late: number }>
  /** Milisegundos hasta el próximo evento de `handlers` que se podrá reclamar (0 o menos si ya hay), o `null` si no hay ninguno. */
  millisecondsUntilNextDue(p: { handlers: readonly string[] }): Promise<number | null>
}

export const OUTBOX_EVENT_REPOSITORY = Symbol('OUTBOX_EVENT_REPOSITORY')
