import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common'
import { APP_CONFIG, type AppConfig } from '#/common/config/index.js'
import {
  OUTBOX_WAKE_UP,
  type OutboxWakeUpSignal,
  PublishOutboxEventsUseCase,
} from '#/modules/outbox/index.js'

/**
 * Espera hasta la próxima pasada: hasta el próximo evento reclamable, con `pollIntervalMs` como tope
 * y como espera cuando no hay ninguno (así una base que escala a cero puede suspenderse). Si la pasada
 * no procesó nada y aun así hay algo vencido (filas bloqueadas por otra transacción), espera el
 * intervalo completo en vez de consultar en bucle.
 */
export function nextPassDelayMs(input: {
  processed: number
  nextDueMs: number | null
  pollIntervalMs: number
}): number {
  const { processed, nextDueMs, pollIntervalMs } = input
  if (nextDueMs === null) return pollIntervalMs
  if (nextDueMs <= 0 && processed === 0) return pollIntervalMs
  return Math.min(Math.max(Math.ceil(nextDueMs), 0), pollIntervalMs)
}

/**
 * Corre el publicador si `OUTBOX_POLLER_ENABLED`: una pasada al arrancar, otra cuando vence la espera
 * de `nextPassDelayMs` y otra en cuanto `OUTBOX_WAKE_UP` avisa. Nunca hay dos pasadas a la vez: un
 * aviso durante una pasada corre otra al terminar. Al apagar deja de programar y avisa a la pasada
 * en curso, que no reclama más, devuelve a `PENDING` lo reclamado sin empezar y solo termina el envío
 * en curso (como mucho `OUTBOX_HANDLER_TIMEOUT_MS`); después la espera. El pool de la base se cierra
 * más tarde, en `onApplicationShutdown`.
 *
 * Las pasadas corren en un solo bucle que empieza al arrancar la app, fuera de toda petición. Un aviso
 * solo marca y despierta la espera del bucle: la pasada nunca corre en el contexto asíncrono de quien
 * avisa. Si corriera ahí, heredaría el de la petición HTTP que llamó a `notify()` (el logger de
 * nestjs-pino con su `correlationId`), y también sus temporizadores y todas las pasadas siguientes.
 */
@Injectable()
export class OutboxPublisherScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherScheduler.name)
  /** Se aborta al apagar: la pasada en curso lo recibe en `execute`. */
  private readonly stopping = new AbortController()
  /** El bucle de pasadas, o `null` si el sondeo está apagado. */
  private loop: Promise<void> | null = null
  /** Hubo un aviso que la pasada en curso (o la próxima) todavía no atendió. */
  private woken = false
  /** Corta la espera entre pasadas; `null` mientras no se espera. */
  private interruptWait: (() => void) | null = null
  private unsubscribe: (() => void) | null = null

  constructor(
    @Inject(PublishOutboxEventsUseCase) private readonly publish: PublishOutboxEventsUseCase,
    @Inject(OUTBOX_WAKE_UP) private readonly wakeUp: OutboxWakeUpSignal,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.outbox.pollerEnabled || this.loop !== null) return
    this.unsubscribe = this.wakeUp.subscribe(() => this.wake())
    // `pass` no lanza; esto solo evita un rechazo sin atender si algo del propio bucle fallara.
    this.loop = this.runLoop().catch((error: unknown) => {
      this.logger.error({ err: error }, 'se detuvo el bucle del publicador del outbox')
    })
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping.abort()
    this.unsubscribe?.()
    this.unsubscribe = null
    this.interruptWait?.()
    await this.loop
  }

  /**
   * Una pasada ya o, si hay una en curso, otra apenas termine. No corre nada aquí: lo llama
   * `notify()`, dentro de la petición que encoló.
   */
  wake(): void {
    if (this.loop === null || this.stopping.signal.aborted) return
    this.woken = true
    this.interruptWait?.()
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping.signal.aborted) {
      const delayMs = await this.pass()
      if (this.stopping.signal.aborted) break
      await this.waitUpTo(delayMs)
    }
  }

  /** Corre `execute` hasta que no queden avisos sin atender y devuelve la espera hasta la próxima. */
  private async pass(): Promise<number> {
    let processed = 0
    let nextDueMs: number | null = null
    try {
      do {
        this.woken = false
        const result = await this.publish.execute({ signal: this.stopping.signal })
        const count = result.published + result.retried + result.deadLettered + result.leaseLost
        processed += count
        if (count > 0) this.logger.log(result, 'outbox procesado')
      } while (this.woken && !this.stopping.signal.aborted)
      if (!this.stopping.signal.aborted) nextDueMs = await this.publish.nextDueInMs()
    } catch (error) {
      this.logger.error({ err: error }, 'falló una pasada del publicador del outbox')
    }
    const pollIntervalMs = this.config.outbox.pollIntervalMs
    return this.woken ? 0 : nextPassDelayMs({ processed, nextDueMs, pollIntervalMs })
  }

  /**
   * Espera `delayMs`, o menos si llega un aviso o el apagado. Siempre con un temporizador, aunque sea de
   * 0 ms: entre dos pasadas el bucle cede el turno al resto del proceso.
   */
  private waitUpTo(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.interruptWait = null
        resolve()
      }
      const timer = setTimeout(done, this.woken ? 0 : delayMs)
      timer.unref()
      this.interruptWait = done
    })
  }
}
