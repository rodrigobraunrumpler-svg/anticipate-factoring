import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MaintenanceScheduler, type MaintenanceTask } from './maintenance.scheduler.js'

const silent = { log: () => undefined, error: () => undefined }
const INTERVAL_MS = 60_000

/** Tarea que registra cada corrida y tarda `durationMs` (con los temporizadores falsos). */
function recordingTask(name: string, log: string[], durationMs = 0): MaintenanceTask {
  return {
    name,
    async run() {
      log.push(`${name}:inicio`)
      if (durationMs > 0) await new Promise((resolve) => setTimeout(resolve, durationMs))
      log.push(`${name}:fin`)
    },
  }
}

/** Promesa que el test resuelve cuando quiere. */
function deferred() {
  let settle: () => void = () => undefined
  const promise = new Promise<void>((resolve) => {
    settle = resolve
  })
  return { promise, resolve: () => settle() }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('MaintenanceScheduler', () => {
  it('con enabled=false no programa ninguna pasada', async () => {
    const log: string[] = []
    const logger = { log: vi.fn(), error: vi.fn() }
    const scheduler = new MaintenanceScheduler(
      { enabled: false, intervalMs: INTERVAL_MS },
      [recordingTask('tarea', log)],
      logger,
    )

    scheduler.onApplicationBootstrap()
    await vi.advanceTimersByTimeAsync(10 * INTERVAL_MS)

    expect(log).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    expect(logger.log).toHaveBeenCalledWith(
      'Mantenimiento desactivado (MAINTENANCE_ENABLED=false).',
    )
  })

  it('corre una pasada al arrancar y la siguiente intervalMs después de que termina la anterior', async () => {
    const log: string[] = []
    const scheduler = new MaintenanceScheduler(
      { enabled: true, intervalMs: INTERVAL_MS },
      [recordingTask('tarea', log, 5_000)],
      silent,
    )

    scheduler.onApplicationBootstrap()
    await vi.advanceTimersByTimeAsync(0)
    expect(log).toEqual(['tarea:inicio'])

    await vi.advanceTimersByTimeAsync(5_000)
    expect(log).toEqual(['tarea:inicio', 'tarea:fin'])

    // La segunda empieza 60 s después del fin de la primera (t = 65 s), no a los 60 s.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS - 1)
    expect(log).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(log).toEqual(['tarea:inicio', 'tarea:fin', 'tarea:inicio'])

    const destroying = scheduler.onModuleDestroy()
    await vi.advanceTimersByTimeAsync(5_000)
    await destroying
  })

  it('una tarea que falla no frena a las siguientes y el informe lo dice', async () => {
    const log: string[] = []
    const logger = { log: vi.fn(), error: vi.fn() }
    const failing: MaintenanceTask = {
      name: 'rota',
      run: () => Promise.reject(new Error('sin conexión')),
    }
    const scheduler = new MaintenanceScheduler(
      { enabled: false, intervalMs: INTERVAL_MS },
      [failing, recordingTask('siguiente', log)],
      logger,
    )

    await expect(scheduler.runOnce()).resolves.toEqual({
      completed: ['siguiente'],
      failed: ['rota'],
      skipped: [],
    })
    expect(log).toEqual(['siguiente:inicio', 'siguiente:fin'])
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'rota' }),
      'Falló una tarea de mantenimiento.',
    )
  })

  it('runOnce durante una pasada devuelve esa misma pasada, sin solaparlas', async () => {
    const log: string[] = []
    const scheduler = new MaintenanceScheduler(
      { enabled: false, intervalMs: INTERVAL_MS },
      [recordingTask('tarea', log, 1_000)],
      silent,
    )

    const first = scheduler.runOnce()
    const second = scheduler.runOnce()
    expect(second).toBe(first)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(first).resolves.toEqual({ completed: ['tarea'], failed: [], skipped: [] })
    expect(log).toEqual(['tarea:inicio', 'tarea:fin'])
  })

  it('al destruir el módulo espera la pasada en curso, salta las tareas pendientes y no programa otra', async () => {
    const log: string[] = []
    const gate = deferred()
    const blocking: MaintenanceTask = {
      name: 'en-curso',
      async run() {
        log.push('en-curso:inicio')
        await gate.promise
        log.push('en-curso:fin')
      },
    }
    const scheduler = new MaintenanceScheduler(
      { enabled: true, intervalMs: INTERVAL_MS },
      [blocking, recordingTask('pendiente', log)],
      silent,
    )

    scheduler.onApplicationBootstrap()
    await vi.advanceTimersByTimeAsync(0)
    const pass = scheduler.runOnce()
    let destroyed = false
    const destroying = scheduler.onModuleDestroy().then(() => {
      destroyed = true
    })

    await vi.advanceTimersByTimeAsync(10_000)
    expect(destroyed).toBe(false)

    gate.resolve()
    await destroying
    await expect(pass).resolves.toEqual({
      completed: ['en-curso'],
      failed: [],
      skipped: ['pendiente'],
    })
    expect(log).toEqual(['en-curso:inicio', 'en-curso:fin'])

    await vi.advanceTimersByTimeAsync(10 * INTERVAL_MS)
    expect(log).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
    await expect(scheduler.runOnce()).resolves.toEqual({
      completed: [],
      failed: [],
      skipped: ['en-curso', 'pendiente'],
    })
  })
})
