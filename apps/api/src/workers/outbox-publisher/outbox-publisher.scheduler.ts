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
 * aviso durante una pasada programa otra al terminar. Al apagar deja de programar y avisa a la pasada
 * en curso, que no reclama más, devuelve a `PENDING` lo reclamado sin empezar y solo termina el envío
 * en curso (como mucho `OUTBOX_HANDLER_TIMEOUT_MS`); después la espera. El pool de la base se cierra
 * más tarde, en `onApplicationShutdown`.
 */
@Injectable()
export class OutboxPublisherScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherScheduler.name)
  /** Se aborta al apagar: la pasada en curso lo recibe en `execute`. */
  private readonly stopping = new AbortController()
  private active = false
  private rerun = false
  private current: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private unsubscribe: (() => void) | null = null

  constructor(
    @Inject(PublishOutboxEventsUseCase) private readonly publish: PublishOutboxEventsUseCase,
    @Inject(OUTBOX_WAKE_UP) private readonly wakeUp: OutboxWakeUpSignal,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.outbox.pollerEnabled) return
    this.active = true
    this.unsubscribe = this.wakeUp.subscribe(() => this.wake())
    this.wake()
  }

  async onModuleDestroy(): Promise<void> {
    this.active = false
    this.stopping.abort()
    this.unsubscribe?.()
    this.unsubscribe = null
    this.clearTimer()
    await this.current
  }

  /** Una pasada ya o, si hay una en curso, otra apenas termine. */
  wake(): void {
    if (!this.active) return
    if (this.current !== null) {
      this.rerun = true
      return
    }
    this.clearTimer()
    this.current = this.run()
  }

  private async run(): Promise<void> {
    let processed = 0
    let nextDueMs: number | null = null
    try {
      do {
        this.rerun = false
        const result = await this.publish.execute({ signal: this.stopping.signal })
        const count = result.published + result.retried + result.deadLettered + result.leaseLost
        processed += count
        if (count > 0) this.logger.log(result, 'outbox procesado')
      } while (this.rerun && this.active)
      if (this.active) nextDueMs = await this.publish.nextDueInMs()
    } catch (error) {
      this.logger.error({ err: error }, 'falló una pasada del publicador del outbox')
    } finally {
      this.current = null
    }
    if (!this.active) return
    const pollIntervalMs = this.config.outbox.pollIntervalMs
    const delayMs = this.rerun ? 0 : nextPassDelayMs({ processed, nextDueMs, pollIntervalMs })
    this.rerun = false
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      this.wake()
    }, delayMs)
    this.timer.unref()
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }
}
