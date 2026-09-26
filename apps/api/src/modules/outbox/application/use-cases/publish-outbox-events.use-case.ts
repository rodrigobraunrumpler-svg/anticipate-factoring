import {
  EmailAccountError,
  PermanentEmailError,
  RetryableEmailError,
} from '#/modules/notifications/index.js'
import {
  OutboxDeadLetterError,
  type OutboxFailureCode,
} from '../../domain/exceptions/outbox-failure-code.js'
import { outboxBackoff } from '../../domain/services/outbox-backoff.js'
import {
  hasValidOutboxPayload,
  isValidOutboxHandlerName,
} from '../../domain/services/outbox-message.js'
import type { ClaimedOutboxEvent } from '../../domain/types/outbox-event.types.js'
import type { OutboxEventHandler } from '../ports/outbox-event-handler.port.js'
import type { OutboxEventRepositoryPort } from '../ports/outbox-event-repository.port.js'

export type PublishOutboxEventsOptions = {
  leaseSeconds: number
  batchSize: number
  handlerTimeoutMs: number
  baseDelayMs: number
  maxDelayMs: number
  /** Nombres que deben tener handler: sin ellos, la API no arranca. */
  requiredHandlers: readonly string[]
}

export type PublishOutboxEventsResult = {
  published: number
  retried: number
  deadLettered: number
  /**
   * Eventos cuyo resultado este proceso no escribió: otro proceso los retomó, o su handler no terminó
   * tras el aviso de tope mientras el arriendo daba margen. En los dos casos decide el arriendo.
   */
  leaseLost: number
}

/**
 * Lo que usa del logger de Nest (con nestjs-pino): contexto estructurado y mensaje. `error` es lo que
 * pide que alguien actúe (la cuenta del proveedor de correo rechazada): el nivel sirve para alertar.
 */
export interface OutboxLogger {
  warn(context: Record<string, unknown>, message: string): void
  error(context: Record<string, unknown>, message: string): void
}

type Failure = {
  code: OutboxFailureCode
  retryable: boolean
  retryAfterSeconds: number | undefined
  /** Pide que alguien actúe: se registra como error. */
  alert: boolean
}

/** Cómo terminó un handler. */
type HandlerOutcome =
  | { kind: 'sent'; sent: { providerMessageId: string | null } }
  | { kind: 'failed'; error: unknown }

/** Motivo con el que se aborta la señal del handler al vencer su tope: se clasifica `HANDLER_TIMEOUT`. */
class HandlerTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`El handler no terminó en ${timeoutMs} ms`)
    this.name = 'HandlerTimeoutError'
  }
}

/**
 * Publica los eventos vencidos de los handlers registrados. Por cada evento: empieza el intento (lo
 * cuenta, renueva el arriendo y toma el token del intento; si otro proceso lo retomó, lo salta), busca
 * su handler, valida el payload, ejecuta el handler con tope de tiempo y escribe el resultado con el
 * token del intento. Lo reclamado que no llega a empezar se devuelve sin gastar intento.
 */
export class PublishOutboxEventsUseCase {
  /** Los nombres registrados, ordenados: esta versión solo reclama estos. */
  readonly handlerNames: readonly string[]
  private readonly handlers: ReadonlyMap<string, OutboxEventHandler>

  constructor(
    private readonly repository: OutboxEventRepositoryPort,
    handlers: readonly OutboxEventHandler[],
    private readonly options: PublishOutboxEventsOptions,
    private readonly logger: OutboxLogger,
    private readonly random: () => number = Math.random,
  ) {
    this.handlers = indexHandlers(handlers, options.requiredHandlers)
    this.handlerNames = [...this.handlers.keys()].sort()
  }

  /**
   * Una pasada: reclama lotes mientras vengan llenos, hasta `maxBatches`. `signal` es el apagado: al
   * abortar no reclama más, devuelve lo reclamado sin empezar y solo termina el handler en curso (que
   * igual corta en su tope).
   */
  async execute({
    maxBatches = 10,
    signal,
  }: {
    maxBatches?: number
    signal?: AbortSignal
  } = {}): Promise<PublishOutboxEventsResult> {
    const result: PublishOutboxEventsResult = {
      published: 0,
      retried: 0,
      deadLettered: 0,
      leaseLost: 0,
    }
    const stopping = () => signal?.aborted === true
    if (this.handlerNames.length > 0) {
      for (let batch = 0; batch < maxBatches && !stopping(); batch++) {
        const events = await this.repository.claimDue({
          handlers: this.handlerNames,
          leaseSeconds: this.options.leaseSeconds,
          batchSize: this.options.batchSize,
        })
        await this.publishBatch(events, result, signal)
        if (events.length < this.options.batchSize) break
      }
    }
    // Al apagar no hace nada más: la próxima pasada de cualquier instancia se encarga.
    if (stopping()) return result
    const exhausted = await this.repository.deadLetterExhausted()
    if (exhausted > 0) {
      result.deadLettered += exhausted
      // Error y no aviso: es una señal de alerta propia, además del `degraded` de la readiness.
      this.logger.error(
        { count: exhausted },
        'eventos del outbox sin intentos restantes pasaron a DEAD_LETTER: sus correos no salen hasta que alguien los reenvíe',
      )
    }
    return result
  }

  /** Milisegundos hasta el próximo evento reclamable de los handlers registrados, o `null` si no hay. */
  nextDueInMs(): Promise<number | null> {
    if (this.handlerNames.length === 0) return Promise.resolve(null)
    return this.repository.millisecondsUntilNextDue({ handlers: this.handlerNames })
  }

  /**
   * Publica un lote en orden. Si llega el apagado o algo lanza a mitad, devuelve lo reclamado que no
   * empezó: otro proceso lo toma ya, sin esperar a que venza el arriendo y sin gastar un intento.
   */
  private async publishBatch(
    events: readonly ClaimedOutboxEvent[],
    result: PublishOutboxEventsResult,
    stop: AbortSignal | undefined,
  ): Promise<void> {
    let done = 0
    try {
      for (const event of events) {
        if (stop?.aborted === true) break
        await this.publishOne(event, result, stop)
        done++
      }
    } finally {
      await this.releaseUnstarted(events.slice(done))
    }
  }

  /**
   * Con el token del reclamo: si el evento en el que algo lanzó ya había empezado, su token cambió y la
   * base no lo toca. Un fallo aquí no tapa el error original; esos eventos se retoman al vencer su
   * arriendo.
   */
  private async releaseUnstarted(events: readonly ClaimedOutboxEvent[]): Promise<void> {
    if (events.length === 0) return
    const claims = events.map(({ id, leaseToken }) => ({ id, leaseToken }))
    try {
      const released = await this.repository.releaseClaims({ claims })
      if (released > 0) {
        this.logger.warn(
          { count: released },
          'eventos del outbox reclamados sin empezar devueltos a PENDING',
        )
      }
    } catch (error) {
      this.logger.warn(
        { count: claims.length, err: error },
        'no se pudieron devolver los eventos reclamados del outbox: se retoman al vencer su arriendo',
      )
    }
  }

  private async publishOne(
    claimed: ClaimedOutboxEvent,
    result: PublishOutboxEventsResult,
    stop: AbortSignal | undefined,
  ): Promise<void> {
    // Antes de renovar: la base vence el arriendo como pronto `leaseSeconds` después de este instante.
    const leaseFrom = performance.now()
    // Se empieza justo antes de enviar: un lote lento nunca envía con el arriendo vencido, y lo que
    // otro proceso retomó mientras tanto no se envía.
    const leaseToken = await this.repository.startAttempt({
      id: claimed.id,
      leaseToken: claimed.leaseToken,
      leaseSeconds: this.options.leaseSeconds,
    })
    if (leaseToken === null) {
      this.leaseLost(claimed, 'startAttempt', result)
      return
    }
    const event: ClaimedOutboxEvent = { ...claimed, leaseToken }
    const handler = this.handlers.get(event.handler)
    if (handler === undefined) {
      await this.deadLetter(event, 'HANDLER_MISSING', result)
      return
    }
    if (!hasValidOutboxPayload(event)) {
      await this.deadLetter(event, 'PAYLOAD_INVALID', result)
      return
    }
    const outcome = await this.runHandler(handler, event, leaseFrom, stop)
    if (outcome === undefined) {
      result.leaseLost++
      this.logger.warn(
        {
          eventId: event.id,
          handler: event.handler,
          attempts: event.attempts,
          step: 'handlerAbandoned',
          correlationId: event.correlationId,
        },
        'un handler del outbox no terminó tras el aviso de tope: el evento conserva su arriendo y se retoma cuando vence',
      )
      return
    }
    if (outcome.kind === 'failed') {
      await this.fail(event, outcome.error, result)
      return
    }
    // Un error de la base aquí no se trata como fallo del handler: el correo ya salió. La fila queda
    // en PROCESSING, se retoma al vencer el arriendo y el proveedor descarta el duplicado por la clave.
    if (
      await this.repository.markPublished({
        id: event.id,
        leaseToken,
        providerMessageId: outcome.sent.providerMessageId,
      })
    ) {
      result.published++
    } else {
      this.leaseLost(event, 'markPublished', result)
    }
  }

  /**
   * Ejecuta el handler con tope. Al vencer `handlerTimeoutMs` aborta la señal que le dio y espera a que
   * termine: el resultado se escribe (y la fila se suelta) recién cuando no queda nada del handler en
   * curso, así un reintento nunca se superpone con un envío vivo. Si termina bien después del aviso,
   * el correo salió y se publica. Si no termina mientras al arriendo le quede `handlerTimeoutMs` para
   * escribir, o si llega el apagado, se abandona: devuelve `undefined` y la fila conserva su arriendo
   * hasta que vence (la configuración exige `2 × handlerTimeoutMs < leaseSeconds`).
   */
  private async runHandler(
    handler: OutboxEventHandler,
    event: ClaimedOutboxEvent,
    leaseFrom: number,
    stop: AbortSignal | undefined,
  ): Promise<HandlerOutcome | undefined> {
    const { handlerTimeoutMs, leaseSeconds } = this.options
    const deadline = new AbortController()
    const timer = setTimeout(
      () => deadline.abort(new HandlerTimeoutError(handlerTimeoutMs)),
      handlerTimeoutMs,
    )
    const settled = Promise.resolve()
      .then(() => handler.handle(event, deadline.signal))
      .then(
        (sent): HandlerOutcome => ({ kind: 'sent', sent }),
        (error: unknown): HandlerOutcome => ({ kind: 'failed', error }),
      )
    try {
      const onTime = await settledUnless(settled, { signal: deadline.signal })
      if (onTime !== undefined) return onTime
      const graceMs = leaseFrom + leaseSeconds * 1000 - handlerTimeoutMs - performance.now()
      const late = await settledUnless(settled, { signal: stop, timeoutMs: graceMs })
      if (late === undefined) this.watchAbandoned(event, settled)
      return late
    } finally {
      clearTimeout(timer)
    }
  }

  /** Deja constancia de cómo terminó, si termina, un handler abandonado (un `sent` puede duplicar). */
  private watchAbandoned(event: ClaimedOutboxEvent, settled: Promise<HandlerOutcome>): void {
    void settled.then((outcome) => {
      this.logger.warn(
        {
          eventId: event.id,
          handler: event.handler,
          attempts: event.attempts,
          outcome: outcome.kind,
          correlationId: event.correlationId,
        },
        'terminó un handler del outbox que se había abandonado',
      )
    })
  }

  private async fail(event: ClaimedOutboxEvent, error: unknown, result: PublishOutboxEventsResult) {
    const failure = classifyFailure(error)
    const context = {
      eventId: event.id,
      handler: event.handler,
      attempts: event.attempts,
      maxAttempts: event.maxAttempts,
      failureCode: failure.code,
      // Solo el de un error del puerto de correo, que por contrato no lleva datos personales ni
      // secretos (el estado y el código del proveedor). El de cualquier otro error puede traerlos.
      ...(isEmailError(error) ? { detail: error.message } : {}),
      correlationId: event.correlationId,
      err: error,
    }
    if (failure.alert) {
      this.logger.error(
        context,
        'el proveedor de correo rechaza la cuenta (clave, IP, créditos o permisos): el evento se reintenta hasta que se corrija',
      )
    } else {
      this.logger.warn(context, 'falló un evento del outbox')
    }
    if (!failure.retryable || event.attempts >= event.maxAttempts) {
      await this.deadLetter(event, failure.code, result)
      return
    }
    const written = await this.repository.reschedule({
      id: event.id,
      leaseToken: event.leaseToken,
      delaySeconds: this.retryDelaySeconds(event.attempts, failure.retryAfterSeconds),
      failureCode: failure.code,
    })
    if (written) result.retried++
    else this.leaseLost(event, 'reschedule', result)
  }

  /**
   * Segundos hasta el próximo intento: la espera exponencial con jitter o la que pidió el proveedor, la
   * mayor, nunca más que `maxDelayMs`. Lo pedido es un mínimo y no reemplaza a la exponencial: una racha
   * de reinicios cortos del límite no gasta los intentos en segundos. Una espera pedida que no es un
   * número finito y no negativo se ignora. Se redondea hacia arriba, a un segundo como mínimo.
   */
  private retryDelaySeconds(attempts: number, retryAfterSeconds: number | undefined): number {
    const { maxDelayMs } = this.options
    const backoffMs = outboxBackoff(attempts, this.options, this.random() * 2 - 1)
    const askedMs =
      retryAfterSeconds !== undefined &&
      Number.isFinite(retryAfterSeconds) &&
      retryAfterSeconds >= 0
        ? retryAfterSeconds * 1000
        : 0
    const delayMs = Math.min(Math.max(backoffMs, askedMs), maxDelayMs)
    return Math.max(1, Math.ceil(delayMs / 1000))
  }

  private async deadLetter(
    event: ClaimedOutboxEvent,
    failureCode: OutboxFailureCode,
    result: PublishOutboxEventsResult,
  ) {
    const written = await this.repository.markDeadLetter({
      id: event.id,
      leaseToken: event.leaseToken,
      failureCode,
    })
    if (!written) {
      this.leaseLost(event, 'markDeadLetter', result)
      return
    }
    result.deadLettered++
    // Error y no aviso: un correo en DEAD_LETTER (el aviso al equipo de una solicitud nueva, por
    // ejemplo) no sale nunca sin intervención. La readiness lo muestra como `degraded` con 200; este
    // log es la señal para las alertas por nivel.
    this.logger.error(
      {
        eventId: event.id,
        handler: event.handler,
        failureCode,
        correlationId: event.correlationId,
      },
      'evento del outbox en DEAD_LETTER: su correo no sale hasta que alguien lo reenvíe',
    )
  }

  private leaseLost(event: ClaimedOutboxEvent, step: string, result: PublishOutboxEventsResult) {
    result.leaseLost++
    this.logger.warn(
      { eventId: event.id, handler: event.handler, step, correlationId: event.correlationId },
      'arriendo del outbox perdido: otro proceso retomó el evento y este resultado se descarta',
    )
  }
}

/**
 * Lo que da `settled` si llega primero; `undefined` si antes aborta `until.signal` o pasan
 * `until.timeoutMs`. Un `settled` que ya terminó gana siempre: la señal y el plazo se miran después.
 */
function settledUnless<T>(
  settled: Promise<T>,
  until: { signal?: AbortSignal | undefined; timeoutMs?: number },
): Promise<T | undefined> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const giveUp = () => finish(undefined)
    const finish = (value: T | undefined) => {
      clearTimeout(timer)
      until.signal?.removeEventListener('abort', giveUp)
      resolve(value)
    }
    void settled.then(finish)
    if (until.timeoutMs !== undefined) timer = setTimeout(giveUp, Math.max(0, until.timeoutMs))
    if (until.signal?.aborted === true) queueMicrotask(giveUp)
    else until.signal?.addEventListener('abort', giveUp, { once: true })
  })
}

function indexHandlers(
  handlers: readonly OutboxEventHandler[],
  requiredHandlers: readonly string[],
): ReadonlyMap<string, OutboxEventHandler> {
  const index = new Map<string, OutboxEventHandler>()
  for (const handler of handlers) {
    if (!isValidOutboxHandlerName(handler.handler)) {
      throw new Error(
        `Nombre de handler del outbox inválido: «${handler.handler}» (minúsculas, dígitos, puntos y guiones; hasta 60 caracteres).`,
      )
    }
    if (index.has(handler.handler)) {
      throw new Error(`Hay dos handlers del outbox con el nombre «${handler.handler}».`)
    }
    index.set(handler.handler, handler)
  }
  const missing = requiredHandlers.filter((name) => !index.has(name))
  if (missing.length > 0) {
    throw new Error(
      `Faltan handlers del outbox: ${missing.join(', ')}. La API no arranca sin ellos.`,
    )
  }
  return index
}

function isEmailError(error: unknown): error is RetryableEmailError | PermanentEmailError {
  return error instanceof RetryableEmailError || error instanceof PermanentEmailError
}

function classifyFailure(error: unknown): Failure {
  const retry = (code: OutboxFailureCode, retryAfterSeconds?: number, alert = false): Failure => ({
    code,
    retryable: true,
    retryAfterSeconds,
    alert,
  })
  const deadLetter = (code: OutboxFailureCode): Failure => ({
    code,
    retryable: false,
    retryAfterSeconds: undefined,
    alert: false,
  })
  if (error instanceof HandlerTimeoutError) return retry('HANDLER_TIMEOUT')
  // Antes que RetryableEmailError, de la que hereda.
  if (error instanceof EmailAccountError) {
    return retry('EMAIL_ACCOUNT', error.retryAfterSeconds, true)
  }
  if (error instanceof RetryableEmailError) return retry('EMAIL_RETRYABLE', error.retryAfterSeconds)
  if (error instanceof PermanentEmailError) return deadLetter('EMAIL_PERMANENT')
  if (error instanceof OutboxDeadLetterError) return deadLetter(error.failureCode)
  return retry('UNEXPECTED')
}
