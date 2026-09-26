import type { OutboxFailureCode } from '../../domain/exceptions/outbox-failure-code.js'
import type { ClaimedOutboxEvent } from '../../domain/types/outbox-event.types.js'

/** Un reclamo: el evento y el token con el que se reclamó. */
export type OutboxClaim = { id: string; leaseToken: string }

/**
 * Persistencia del outbox. Todos los tiempos los pone la base (`now()`). Toda escritura de vuelta
 * exige `id` y `leaseToken`, y devuelve `false` si el arriendo ya no es de quien escribe (otro proceso
 * retomó el evento): ese resultado se descarta.
 *
 * Reclamar no es intentar: `claimDue` reserva el evento con un token de reclamo y `startAttempt`, justo
 * antes de ejecutar el handler, cuenta el intento y lo cambia por el token del intento. Un reclamo que
 * vence sin empezar (un lote lento, un proceso que se apaga o cae) no gasta intentos: otro proceso lo
 * retoma con el mismo número de intento.
 */
export interface OutboxEventRepositoryPort {
  /**
   * Una sola sentencia con `FOR UPDATE SKIP LOCKED`: solo `handlers`, `attempts < max_attempts`,
   * pendientes vencidos o arriendos vencidos. No cuenta el intento: `attempts` del evento devuelto es
   * el número que tendrá el intento al empezar.
   */
  claimDue(p: {
    handlers: readonly string[]
    leaseSeconds: number
    batchSize: number
  }): Promise<ClaimedOutboxEvent[]>
  /**
   * Empieza el intento de un evento reclamado: suma el intento, renueva el arriendo por `leaseSeconds`
   * y cambia el token del reclamo por uno nuevo, que es el que usan las escrituras de vuelta. Devuelve
   * ese token, o `null` si el reclamo ya no es de quien llama (otro proceso lo retomó o ya empezó).
   */
  startAttempt(p: { id: string; leaseToken: string; leaseSeconds: number }): Promise<string | null>
  /**
   * Devuelve a `PENDING`, sin gastar intento ni cambiar `available_at`, los eventos reclamados con
   * estos tokens que no empezaron. Un evento que ya empezó cambió de token y no se toca. Devuelve
   * cuántos devolvió.
   */
  releaseClaims(p: { claims: readonly OutboxClaim[] }): Promise<number>
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
  /**
   * Pasa a `DEAD_LETTER` los eventos sin intentos restantes: pendientes, o en proceso con el arriendo
   * vencido (su último intento empezó y nunca informó el resultado).
   */
  deadLetterExhausted(): Promise<number>
  /** Un lote de `DELETE` por rango de PK: `id < uuidv7_floor(now() - días) AND status = 'PUBLISHED'`. */
  purgePublished(p: { olderThanDays: number; batchSize: number }): Promise<number>
  /** Eventos en `DEAD_LETTER` y atrasados más de `lateAfterSeconds`. Cada conteo tiene un tope (la readiness solo necesita saber si hay). */
  countBacklog(p: { lateAfterSeconds: number }): Promise<{ deadLetter: number; late: number }>
  /** Milisegundos hasta el próximo evento de `handlers` que se podrá reclamar (0 o menos si ya hay), o `null` si no hay ninguno. */
  millisecondsUntilNextDue(p: { handlers: readonly string[] }): Promise<number | null>
}

export const OUTBOX_EVENT_REPOSITORY = Symbol('OUTBOX_EVENT_REPOSITORY')
