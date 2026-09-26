import { Logger } from '@nestjs/common'
import type { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus'
import type { OutboxEventRepositoryPort } from '#/modules/outbox/index.js'

export type OutboxBacklogReadinessOptions = {
  /** Segundos después de `available_at` a partir de los cuales un evento cuenta como atrasado. */
  readonly lateAfterSeconds: number
  /** Tope de la consulta; pasado este tiempo el outbox cuenta como caído. */
  readonly timeoutMs: number
  /** Un resultado se reutiliza durante este tiempo: una ráfaga de sondeos hace una sola consulta. */
  readonly cacheTtlMs: number
}

export const OUTBOX_BACKLOG_TIMEOUT_MS = 2_000
export const OUTBOX_BACKLOG_CACHE_TTL_MS = 5_000
/** Margen del tope de Terminus sobre el propio: solo actúa si el tope propio no llega a disparar. */
const HARD_TIMEOUT_MARGIN_MS = 500

/** Textos de la sonda, que es pública: el error real va al log, nunca a la respuesta. */
export const OUTBOX_BACKLOG_UNAVAILABLE_MESSAGE = 'No se pudo consultar el outbox.'
export const outboxBacklogTimeoutMessage = (timeoutMs: number) =>
  `El outbox no respondió en ${timeoutMs} ms.`

/**
 * Un evento vencido lo reclama el siguiente sondeo (a lo sumo `pollIntervalMs`), y si el proceso que
 * lo tomó muere, se retoma cuando vence su arriendo (`leaseSeconds`). Pasado eso, con margen de dos
 * sondeos, el evento está atrasado.
 */
export function outboxLateAfterSeconds(outbox: {
  readonly leaseSeconds: number
  readonly pollIntervalMs: number
}): number {
  return outbox.leaseSeconds + 2 * Math.ceil(outbox.pollIntervalMs / 1_000)
}

class BacklogTimeoutError extends Error {}

/**
 * Backlog del outbox en `GET /health/readiness`.
 *
 * Con eventos en DEAD_LETTER o atrasados responde `degraded`, no `down`: la readiness decide si la
 * réplica recibe tráfico y todas las réplicas leen la misma tabla, así que un `down` sacaría de
 * rotación a todas a la vez y convertiría "un correo no salió" en "la API se cayó". Terminus mantiene
 * el 200 con `degraded` y el monitoreo alerta con los números. Solo responde `down` si la consulta
 * misma falla o no responde a tiempo.
 */
export class OutboxBacklogReadinessIndicator {
  private readonly logger = new Logger(OutboxBacklogReadinessIndicator.name)

  constructor(
    private readonly outbox: Pick<OutboxEventRepositoryPort, 'countBacklog'>,
    private readonly indicators: HealthIndicatorService,
    private readonly options: OutboxBacklogReadinessOptions,
  ) {}

  async check(key: string): Promise<HealthIndicatorResult> {
    const result = await this.indicators
      .check(key)
      .attempt(() => this.readBacklog())
      .withTimeout(this.options.timeoutMs + HARD_TIMEOUT_MARGIN_MS)
      .cacheFor(this.options.cacheTtlMs)
    const detail = result[key]
    if (detail?.status === 'up' && (detail.deadLetter > 0 || detail.late > 0)) {
      const { status: _status, ...data } = detail
      return this.indicators.check(key).degraded(data)
    }
    return result
  }

  private async readBacklog(): Promise<{
    deadLetter: number
    late: number
    lateAfterSeconds: number
  }> {
    const { lateAfterSeconds, timeoutMs } = this.options
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BacklogTimeoutError()), timeoutMs)
    })
    try {
      const backlog = await Promise.race([this.outbox.countBacklog({ lateAfterSeconds }), timeout])
      return { deadLetter: backlog.deadLetter, late: backlog.late, lateAfterSeconds }
    } catch (error) {
      if (error instanceof BacklogTimeoutError) {
        throw new Error(outboxBacklogTimeoutMessage(timeoutMs))
      }
      this.logger.error({ err: error }, 'No se pudo consultar el backlog del outbox.')
      throw new Error(OUTBOX_BACKLOG_UNAVAILABLE_MESSAGE)
    } finally {
      clearTimeout(timer)
    }
  }
}
