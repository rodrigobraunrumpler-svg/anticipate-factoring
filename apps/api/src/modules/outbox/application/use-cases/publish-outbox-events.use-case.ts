import { PermanentEmailError, RetryableEmailError } from '#/modules/notifications/index.js'
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
  leaseLost: number
}

/** Lo que usa del logger de Nest (con nestjs-pino): contexto estructurado y mensaje. */
export interface OutboxLogger {
  warn(context: Record<string, unknown>, message: string): void
}

type Failure = {
  code: OutboxFailureCode
  retryable: boolean
  retryAfterSeconds: number | undefined
}

class HandlerTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`El handler no terminó en ${timeoutMs} ms`)
    this.name = 'HandlerTimeoutError'
  }
}

/**
 * Publica los eventos vencidos de los handlers registrados. Por cada evento: renueva el arriendo (si
 * otro proceso lo tomó, lo salta), busca su handler, valida el payload, ejecuta el handler con tope
 * de tiempo y escribe el resultado con el token de su reclamo.
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

  async execute({
    maxBatches = 10,
  }: {
    maxBatches?: number
  } = {}): Promise<PublishOutboxEventsResult> {
    const result: PublishOutboxEventsResult = {
      published: 0,
      retried: 0,
      deadLettered: 0,
      leaseLost: 0,
    }
    if (this.handlerNames.length > 0) {
      for (let batch = 0; batch < maxBatches; batch++) {
        const events = await this.repository.claimDue({
          handlers: this.handlerNames,
          leaseSeconds: this.options.leaseSeconds,
          batchSize: this.options.batchSize,
        })
        for (const event of events) await this.publishOne(event, result)
        if (events.length < this.options.batchSize) break
      }
    }
    const exhausted = await this.repository.deadLetterExhausted()
    if (exhausted > 0) {
      result.deadLettered += exhausted
      this.logger.warn(
        { count: exhausted },
        'eventos del outbox sin intentos restantes pasaron a DEAD_LETTER',
      )
    }
    return result
  }

  /** Milisegundos hasta el próximo evento reclamable de los handlers registrados, o `null` si no hay. */
  nextDueInMs(): Promise<number | null> {
    if (this.handlerNames.length === 0) return Promise.resolve(null)
    return this.repository.millisecondsUntilNextDue({ handlers: this.handlerNames })
  }

  private async publishOne(
    event: ClaimedOutboxEvent,
    result: PublishOutboxEventsResult,
  ): Promise<void> {
    const lease = { id: event.id, leaseToken: event.leaseToken }
    // Se renueva justo antes de enviar: un lote lento nunca envía con el arriendo vencido.
    if (
      !(await this.repository.renewLease({ ...lease, leaseSeconds: this.options.leaseSeconds }))
    ) {
      this.leaseLost(event, 'renewLease', result)
      return
    }
    const handler = this.handlers.get(event.handler)
    if (handler === undefined) {
      await this.deadLetter(event, 'HANDLER_MISSING', result)
      return
    }
    if (!hasValidOutboxPayload(event)) {
      await this.deadLetter(event, 'PAYLOAD_INVALID', result)
      return
    }
    let sent: { providerMessageId: string | null }
    try {
      sent = await this.runHandler(handler, event)
    } catch (error) {
      await this.fail(event, error, result)
      return
    }
    // Un error de la base aquí no se trata como fallo del handler: el correo ya salió. La fila queda
    // en PROCESSING, se retoma al vencer el arriendo y el proveedor descarta el duplicado por la clave.
    if (
      await this.repository.markPublished({ ...lease, providerMessageId: sent.providerMessageId })
    ) {
      result.published++
    } else {
      this.leaseLost(event, 'markPublished', result)
    }
  }

  private async runHandler(
    handler: OutboxEventHandler,
    event: ClaimedOutboxEvent,
  ): Promise<{ providerMessageId: string | null }> {
    const timeoutMs = this.options.handlerTimeoutMs
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HandlerTimeoutError(timeoutMs)), timeoutMs)
    })
    try {
      return await Promise.race([Promise.resolve().then(() => handler.handle(event)), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  private async fail(event: ClaimedOutboxEvent, error: unknown, result: PublishOutboxEventsResult) {
    const failure = classifyFailure(error)
    this.logger.warn(
      {
        eventId: event.id,
        handler: event.handler,
        attempts: event.attempts,
        maxAttempts: event.maxAttempts,
        failureCode: failure.code,
        correlationId: event.correlationId,
        err: error,
      },
      'falló un evento del outbox',
    )
    if (!failure.retryable || event.attempts >= event.maxAttempts) {
      await this.deadLetter(event, failure.code, result)
      return
    }
    const delayMs =
      failure.retryAfterSeconds === undefined
        ? outboxBackoff(event.attempts, this.options, this.random() * 2 - 1)
        : Math.min(failure.retryAfterSeconds * 1000, this.options.maxDelayMs)
    const written = await this.repository.reschedule({
      id: event.id,
      leaseToken: event.leaseToken,
      delaySeconds: Math.max(1, Math.ceil(delayMs / 1000)),
      failureCode: failure.code,
    })
    if (written) result.retried++
    else this.leaseLost(event, 'reschedule', result)
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
    this.logger.warn(
      {
        eventId: event.id,
        handler: event.handler,
        failureCode,
        correlationId: event.correlationId,
      },
      'evento del outbox en DEAD_LETTER',
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

function classifyFailure(error: unknown): Failure {
  if (error instanceof HandlerTimeoutError) {
    return { code: 'HANDLER_TIMEOUT', retryable: true, retryAfterSeconds: undefined }
  }
  if (error instanceof RetryableEmailError) {
    return { code: 'EMAIL_RETRYABLE', retryable: true, retryAfterSeconds: error.retryAfterSeconds }
  }
  if (error instanceof PermanentEmailError) {
    return { code: 'EMAIL_PERMANENT', retryable: false, retryAfterSeconds: undefined }
  }
  if (error instanceof OutboxDeadLetterError) {
    return { code: error.failureCode, retryable: false, retryAfterSeconds: undefined }
  }
  return { code: 'UNEXPECTED', retryable: true, retryAfterSeconds: undefined }
}
