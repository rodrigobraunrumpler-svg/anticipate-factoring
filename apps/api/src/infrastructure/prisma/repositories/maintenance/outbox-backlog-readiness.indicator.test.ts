import { Logger } from '@nestjs/common'
import { HealthIndicatorService } from '@nestjs/terminus'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { OutboxEventRepositoryPort } from '#/modules/outbox/index.js'
import {
  OUTBOX_BACKLOG_UNAVAILABLE_MESSAGE,
  OutboxBacklogReadinessIndicator,
  type OutboxBacklogReadinessOptions,
  outboxBacklogTimeoutMessage,
  outboxLateAfterSeconds,
} from './outbox-backlog-readiness.indicator.js'

type Backlog = { deadLetter: number; late: number }
type CountBacklog = OutboxEventRepositoryPort['countBacklog']

const options: OutboxBacklogReadinessOptions = {
  lateAfterSeconds: 130,
  timeoutMs: 50,
  cacheTtlMs: 0,
}

function indicatorWith(
  countBacklog: CountBacklog,
  overrides: Partial<OutboxBacklogReadinessOptions> = {},
) {
  return new OutboxBacklogReadinessIndicator({ countBacklog }, new HealthIndicatorService(), {
    ...options,
    ...overrides,
  })
}

const returning = (backlog: Backlog) => vi.fn<CountBacklog>(async () => backlog)

beforeAll(() => {
  // El indicador registra el error real con el Logger de Nest; en este test no hace falta verlo.
  Logger.overrideLogger(false)
})

describe('OutboxBacklogReadinessIndicator', () => {
  it('sin eventos fallidos ni atrasados está up y muestra los números', async () => {
    const countBacklog = returning({ deadLetter: 0, late: 0 })

    const result = await indicatorWith(countBacklog).check('outbox')

    expect(result.outbox).toMatchObject({
      status: 'up',
      deadLetter: 0,
      late: 0,
      lateAfterSeconds: 130,
    })
    expect(countBacklog).toHaveBeenCalledWith({ lateAfterSeconds: 130 })
  })

  it('con eventos en DEAD_LETTER está degraded, no down', async () => {
    const result = await indicatorWith(returning({ deadLetter: 2, late: 0 })).check('outbox')

    expect(result.outbox).toMatchObject({ status: 'degraded', deadLetter: 2, late: 0 })
  })

  it('con eventos atrasados está degraded', async () => {
    const result = await indicatorWith(returning({ deadLetter: 0, late: 3 })).check('outbox')

    expect(result.outbox).toMatchObject({ status: 'degraded', deadLetter: 0, late: 3 })
  })

  it('si la consulta falla está down con un mensaje en español, sin el error original', async () => {
    const countBacklog = vi.fn<CountBacklog>(async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.12:5432')
    })

    const result = await indicatorWith(countBacklog).check('outbox')

    expect(result.outbox).toMatchObject({
      status: 'down',
      message: OUTBOX_BACKLOG_UNAVAILABLE_MESSAGE,
    })
    expect(JSON.stringify(result)).not.toContain('ECONNREFUSED')
  })

  it('si la consulta no responde a tiempo está down con el tope en el mensaje', async () => {
    const countBacklog = vi.fn<CountBacklog>(() => new Promise<Backlog>(() => undefined))

    const result = await indicatorWith(countBacklog, { timeoutMs: 20 }).check('outbox')

    expect(result.outbox).toMatchObject({
      status: 'down',
      message: outboxBacklogTimeoutMessage(20),
    })
  })

  it('reutiliza el resultado durante cacheTtlMs: una ráfaga de sondeos hace una sola consulta', async () => {
    const countBacklog = returning({ deadLetter: 1, late: 0 })
    const indicator = indicatorWith(countBacklog, { cacheTtlMs: 60_000 })

    await indicator.check('outbox')
    const second = await indicator.check('outbox')

    expect(countBacklog).toHaveBeenCalledTimes(1)
    expect(second.outbox).toMatchObject({ status: 'degraded', deadLetter: 1, cachedResponse: true })
  })

  it('outboxLateAfterSeconds suma el arriendo y dos sondeos', () => {
    expect(outboxLateAfterSeconds({ leaseSeconds: 120, pollIntervalMs: 5_000 })).toBe(130)
    expect(outboxLateAfterSeconds({ leaseSeconds: 60, pollIntervalMs: 1_500 })).toBe(64)
  })
})
