import { AsyncLocalStorage } from 'node:async_hooks'
import { describe, expect, it, vi } from 'vitest'
import type { AppConfig } from '#/common/config/index.js'
import {
  OutboxWakeUpSignal,
  type PublishOutboxEventsResult,
  type PublishOutboxEventsUseCase,
} from '#/modules/outbox/index.js'
import { nextPassDelayMs, OutboxPublisherScheduler } from './outbox-publisher.scheduler.js'

describe('nextPassDelayMs', () => {
  const pollIntervalMs = 5_000

  it('sin eventos pendientes espera el intervalo completo', () => {
    expect(nextPassDelayMs({ processed: 3, nextDueMs: null, pollIntervalMs })).toBe(5_000)
  })

  it('despierta con el próximo evento, acotado por el intervalo', () => {
    expect(nextPassDelayMs({ processed: 1, nextDueMs: 1_200.4, pollIntervalMs })).toBe(1_201)
    expect(nextPassDelayMs({ processed: 0, nextDueMs: 60_000, pollIntervalMs })).toBe(5_000)
    expect(nextPassDelayMs({ processed: 20, nextDueMs: -30, pollIntervalMs })).toBe(0)
  })

  it('si la pasada no procesó nada y hay algo vencido, no consulta en bucle', () => {
    expect(nextPassDelayMs({ processed: 0, nextDueMs: 0, pollIntervalMs })).toBe(5_000)
  })
})

describe('OutboxPublisherScheduler', () => {
  const HOUR_MS = 3_600_000
  const nothing: PublishOutboxEventsResult = {
    published: 0,
    retried: 0,
    deadLettered: 0,
    leaseLost: 0,
  }

  it('cada pasada corre fuera del contexto de quien la despierta: los logs no heredan la petición', async () => {
    // Como el almacenamiento de nestjs-pino: el logger (y su correlationId) de cada petición HTTP.
    const request = new AsyncLocalStorage<string>()
    const seen: (string | undefined)[] = []
    const publish = {
      execute: vi.fn(async () => {
        seen.push(request.getStore())
        return nothing
      }),
      // Tras la pasada inicial, espera el sondeo (una hora). Tras la que despierta la petición,
      // dos pasadas por su temporizador y otra vez el sondeo.
      nextDueInMs: vi
        .fn(async (): Promise<number | null> => {
          seen.push(request.getStore())
          return HOUR_MS
        })
        .mockImplementationOnce(async () => {
          seen.push(request.getStore())
          return HOUR_MS
        })
        .mockImplementationOnce(async () => {
          seen.push(request.getStore())
          return 5
        })
        .mockImplementationOnce(async () => {
          seen.push(request.getStore())
          return 5
        }),
    }
    const wakeUp = new OutboxWakeUpSignal()
    const scheduler = new OutboxPublisherScheduler(
      publish as unknown as PublishOutboxEventsUseCase,
      wakeUp,
      { outbox: { pollerEnabled: true, pollIntervalMs: HOUR_MS } } as AppConfig,
    )
    scheduler.onApplicationBootstrap()
    try {
      await vi.waitFor(() => expect(publish.nextDueInMs).toHaveBeenCalledTimes(1))
      // Una petición encola y avisa después del commit (la Tarea 12), dentro de su contexto.
      request.run('peticion-1', () => wakeUp.notify())
      await vi.waitFor(() => expect(publish.execute).toHaveBeenCalledTimes(4))
      await vi.waitFor(() => expect(publish.nextDueInMs).toHaveBeenCalledTimes(4))
    } finally {
      await scheduler.onModuleDestroy()
    }
    expect(seen).toHaveLength(8)
    expect(seen.filter((store) => store !== undefined)).toEqual([])
  })

  it('un aviso durante una pasada corre otra al terminar, y al apagar no corre más', async () => {
    let finishFirst = () => {}
    const firstPass = new Promise<void>((resolve) => {
      finishFirst = resolve
    })
    const publish = {
      execute: vi
        .fn(async () => nothing)
        .mockImplementationOnce(async () => {
          await firstPass
          return nothing
        }),
      nextDueInMs: vi.fn(async (): Promise<number | null> => null),
    }
    const wakeUp = new OutboxWakeUpSignal()
    const scheduler = new OutboxPublisherScheduler(
      publish as unknown as PublishOutboxEventsUseCase,
      wakeUp,
      { outbox: { pollerEnabled: true, pollIntervalMs: HOUR_MS } } as AppConfig,
    )
    scheduler.onApplicationBootstrap()
    try {
      await vi.waitFor(() => expect(publish.execute).toHaveBeenCalledTimes(1))
      wakeUp.notify()
      wakeUp.notify()
      expect(publish.execute).toHaveBeenCalledTimes(1)
      finishFirst()
      await vi.waitFor(() => expect(publish.nextDueInMs).toHaveBeenCalledTimes(1))
      // Los dos avisos durante la pasada dan una sola pasada más, nunca dos a la vez.
      expect(publish.execute).toHaveBeenCalledTimes(2)
    } finally {
      await scheduler.onModuleDestroy()
    }
    wakeUp.notify()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(publish.execute).toHaveBeenCalledTimes(2)
  })
})
