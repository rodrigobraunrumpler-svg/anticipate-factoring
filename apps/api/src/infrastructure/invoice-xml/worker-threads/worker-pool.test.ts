import { spawnSync } from 'node:child_process'
import { threadId as mainThreadId } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import {
  WorkerPool,
  type WorkerPoolOptions,
  WorkerStartError,
  WorkerTaskError,
  type WorkerTaskOutcome,
} from './worker-pool.js'

/** Un worker de prueba escrito en línea: un módulo ES en una URL `data:`. */
const inlineWorker = (source: string): URL =>
  new URL(`data:text/javascript,${encodeURIComponent(source)}`)

/** Habla el protocolo del pool y hace lo que pide cada tarea (`op`). */
const OPS_WORKER = inlineWorker(`
import { parentPort, resourceLimits, threadId } from 'node:worker_threads'
parentPort.on('message', ({ id, input }) => {
  const reply = (value) => parentPort.postMessage({ kind: 'result', id, value })
  switch (input.op) {
    case 'echo': return reply(input.value)
    case 'thread': return reply(threadId)
    case 'limits': return reply(resourceLimits)
    case 'spin': { const end = Date.now() + input.ms; while (Date.now() < end); return reply('spun') }
    case 'fail': return parentPort.postMessage({ kind: 'failure', id, message: 'falló a propósito' })
    case 'throw': throw new Error('excepción sin atrapar')
    case 'exit': process.exit(3)
    case 'allocate': { const kept = []; for (;;) kept.push(new Array(100000).fill(Math.random())) }
  }
})
parentPort.postMessage({ kind: 'ready' })
`)

/** Falla al cargar: nunca llega a avisar que está listo. */
const BROKEN_WORKER = inlineWorker(`throw new Error('no arranca')`)

type Op =
  | { op: 'echo'; value: unknown }
  | { op: 'thread' }
  | { op: 'limits' }
  | { op: 'spin'; ms: number }
  | { op: 'fail' }
  | { op: 'throw' }
  | { op: 'exit' }
  | { op: 'allocate' }

const pools: WorkerPool<unknown, unknown>[] = []

function createPool(overrides: Partial<WorkerPoolOptions> = {}): WorkerPool<Op, unknown> {
  const pool = new WorkerPool<Op, unknown>({
    script: OPS_WORKER,
    name: 'prueba',
    maxWorkers: 2,
    maxQueued: 8,
    queueTimeoutMs: 10_000,
    taskTimeoutMs: 10_000,
    maxHeapMb: 64,
    ...overrides,
  })
  pools.push(pool as WorkerPool<unknown, unknown>)
  return pool
}

const completed = (value: unknown): WorkerTaskOutcome<unknown> => ({ status: 'completed', value })

/** El valor de una tarea que tiene que completarse. */
async function completedValue(outcome: Promise<WorkerTaskOutcome<unknown>>): Promise<unknown> {
  const result = await outcome
  if (result.status !== 'completed') throw new Error(`la tarea no se completó: ${result.status}`)
  return result.value
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()))
})

describe('WorkerPool: cancelación (plazo del envío)', () => {
  const aborted = { status: 'rejected', reason: 'aborted' } as const

  it('una tarea en la cola sale de la cola al cancelarse y la siguiente conserva su turno', async () => {
    const pool = createPool({ maxWorkers: 1 })
    await pool.start()
    const busy = pool.run({ op: 'spin', ms: 200 })
    const controller = new AbortController()
    const queued = pool.run({ op: 'echo', value: 'no' }, { signal: controller.signal })
    const next = pool.run({ op: 'echo', value: 'sí' })
    expect(pool.stats.queued).toBe(2)

    controller.abort(new Error('plazo del envío'))
    await expect(queued).resolves.toEqual(aborted)
    expect(pool.stats.queued).toBe(1)
    await expect(busy).resolves.toEqual(completed('spun'))
    await expect(next).resolves.toEqual(completed('sí'))
  })

  it('una tarea en curso responde aborted en el acto; su hilo la termina sin reemplazarse y sigue atendiendo', async () => {
    const pool = createPool({ maxWorkers: 1 })
    await pool.start()
    const thread = await completedValue(pool.run({ op: 'thread' }))
    const controller = new AbortController()
    const running = pool.run({ op: 'spin', ms: 300 }, { signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(pool.stats.busy).toBe(1)

    const startedAt = Date.now()
    controller.abort(new Error('plazo del envío'))
    await expect(running).resolves.toEqual(aborted)
    expect(Date.now() - startedAt).toBeLessThan(100)
    // El hilo sigue ocupado con la lectura (acotada por su plazo) y después atiende la siguiente.
    expect(pool.stats.busy).toBe(1)
    await expect(pool.run({ op: 'thread' })).resolves.toEqual(completed(thread))
  })

  it('con la señal ya cancelada no toma lugar en la cola ni en un hilo', async () => {
    const pool = createPool({ maxWorkers: 1 })
    await pool.start()
    const controller = new AbortController()
    controller.abort(new Error('ya vencido'))
    await expect(
      pool.run({ op: 'echo', value: 1 }, { signal: controller.signal }),
    ).resolves.toEqual(aborted)
    expect(pool.stats).toMatchObject({ busy: 0, queued: 0 })
  })
})

describe('WorkerPool', () => {
  it('corre cada tarea en un hilo aparte y devuelve su resultado', async () => {
    const pool = createPool()
    await pool.start()
    const thread = await completedValue(pool.run({ op: 'thread' }))
    expect(thread).toEqual(expect.any(Number))
    expect(thread).not.toBe(mainThreadId)
    await expect(pool.run({ op: 'echo', value: { a: [1, 'b', null] } })).resolves.toEqual(
      completed({ a: [1, 'b', null] }),
    )
  })

  it('nunca tiene más hilos vivos que maxWorkers, aunque lleguen muchas tareas juntas', async () => {
    const pool = createPool({ maxWorkers: 2 })
    let most = 0
    const sampler = setInterval(() => {
      most = Math.max(most, pool.stats.workers)
    }, 1)
    const threads = await Promise.all(
      Array.from({ length: 6 }, () =>
        completedValue(pool.run({ op: 'spin', ms: 30 })).then(() =>
          completedValue(pool.run({ op: 'thread' })),
        ),
      ),
    )
    clearInterval(sampler)
    expect(most).toBeLessThanOrEqual(2)
    expect(new Set(threads).size).toBeLessThanOrEqual(2)
  })

  it('reparte las tareas en el orden en que llegaron', async () => {
    const pool = createPool({ maxWorkers: 1 })
    const finished: number[] = []
    await Promise.all(
      [1, 2, 3, 4, 5].map((value) =>
        completedValue(pool.run({ op: 'echo', value })).then((echoed) =>
          finished.push(echoed as number),
        ),
      ),
    )
    expect(finished).toEqual([1, 2, 3, 4, 5])
  })

  it('una tarea que pasa su plazo termina su hilo, responde timed-out y el pool lo reemplaza', async () => {
    const pool = createPool({ maxWorkers: 1, taskTimeoutMs: 100 })
    await pool.start()
    const first = await completedValue(pool.run({ op: 'thread' }))
    const startedAt = performance.now()
    await expect(pool.run({ op: 'spin', ms: 10_000 })).resolves.toEqual({ status: 'timed-out' })
    expect(performance.now() - startedAt).toBeLessThan(2_000)
    // Con un solo hilo permitido, el reemplazo recién nace cuando el anterior terminó.
    const replacement = await completedValue(pool.run({ op: 'thread' }))
    expect(replacement).not.toBe(first)
    expect(pool.stats.workers).toBe(1)
  })

  it('cada hilo corre con los topes de heap pedidos: generación vieja y, si se indica, joven', async () => {
    const withYoung = createPool({ maxHeapMb: 96, maxYoungGenerationMb: 24 })
    expect(await completedValue(withYoung.run({ op: 'limits' }))).toEqual(
      expect.objectContaining({ maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 24 }),
    )
    const oldOnly = createPool({ maxHeapMb: 80 })
    expect(await completedValue(oldOnly.run({ op: 'limits' }))).toEqual(
      expect.objectContaining({ maxOldGenerationSizeMb: 80 }),
    )
  })

  it('un hilo que pasa su tope de memoria responde out-of-memory y el pool lo reemplaza', async () => {
    const pool = createPool({ maxWorkers: 1, maxHeapMb: 16 })
    await pool.start()
    await expect(pool.run({ op: 'allocate' })).resolves.toEqual({ status: 'out-of-memory' })
    await expect(pool.run({ op: 'echo', value: 'sigue' })).resolves.toEqual(completed('sigue'))
  })

  it('con la cola llena rechaza en el acto con queue-full; lo que ya estaba sigue su curso', async () => {
    const pool = createPool({ maxWorkers: 1, maxQueued: 1 })
    await pool.start()
    const running = pool.run({ op: 'spin', ms: 300 })
    const queued = pool.run({ op: 'echo', value: 'en cola' })
    const startedAt = performance.now()
    await expect(pool.run({ op: 'echo', value: 'sobra' })).resolves.toEqual({
      status: 'rejected',
      reason: 'queue-full',
    })
    expect(performance.now() - startedAt).toBeLessThan(100)
    await expect(running).resolves.toEqual(completed('spun'))
    await expect(queued).resolves.toEqual(completed('en cola'))
  })

  it('una tarea que espera un hilo más que queueTimeoutMs responde queue-timeout y sale de la cola', async () => {
    const pool = createPool({ maxWorkers: 1, queueTimeoutMs: 100 })
    await pool.start()
    const running = pool.run({ op: 'spin', ms: 1_000 })
    const startedAt = performance.now()
    await expect(pool.run({ op: 'echo', value: 'espera' })).resolves.toEqual({
      status: 'rejected',
      reason: 'queue-timeout',
    })
    expect(performance.now() - startedAt).toBeLessThan(900)
    expect(pool.stats.queued).toBe(0)
    await expect(running).resolves.toEqual(completed('spun'))
  })

  it('una falla que informa el worker rechaza con WorkerTaskError y el mismo hilo sigue atendiendo', async () => {
    const pool = createPool({ maxWorkers: 1 })
    await pool.start()
    const before = await completedValue(pool.run({ op: 'thread' }))
    await expect(pool.run({ op: 'fail' })).rejects.toThrow(WorkerTaskError)
    await expect(pool.run({ op: 'fail' })).rejects.toThrow(/falló a propósito/)
    expect(await completedValue(pool.run({ op: 'thread' }))).toBe(before)
  })

  it.each([
    ['una excepción sin atrapar', { op: 'throw' } as const],
    ['un process.exit', { op: 'exit' } as const],
  ])('%s en el worker rechaza con WorkerTaskError y el pool lo reemplaza', async (_, task) => {
    const pool = createPool({ maxWorkers: 1 })
    await pool.start()
    const before = await completedValue(pool.run({ op: 'thread' }))
    await expect(pool.run(task)).rejects.toThrow(WorkerTaskError)
    const after = await completedValue(pool.run({ op: 'thread' }))
    expect(after).not.toBe(before)
  })

  it('una entrada que no se puede clonar rechaza con WorkerTaskError y el hilo queda libre', async () => {
    const pool = createPool({ maxWorkers: 1 })
    await pool.start()
    const before = await completedValue(pool.run({ op: 'thread' }))
    await expect(pool.run({ op: 'echo', value: () => 'no se clona' })).rejects.toThrow(
      WorkerTaskError,
    )
    expect(await completedValue(pool.run({ op: 'thread' }))).toBe(before)
  })

  it('un worker que no arranca: start rechaza, las tareas responden start-failed y no reintenta en bucle', async () => {
    const pool = createPool({ script: BROKEN_WORKER })
    await expect(pool.start()).rejects.toThrow(WorkerStartError)
    await expect(pool.run({ op: 'echo', value: 1 })).resolves.toEqual({
      status: 'rejected',
      reason: 'start-failed',
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(pool.stats.workers).toBe(0)
  })

  it('close termina todos los hilos y responde closed a lo que estaba en curso o en cola', async () => {
    const pool = createPool({ maxWorkers: 1 })
    await pool.start()
    const running = pool.run({ op: 'spin', ms: 5_000 })
    const queued = pool.run({ op: 'echo', value: 'en cola' })
    const startedAt = performance.now()
    await pool.close()
    expect(performance.now() - startedAt).toBeLessThan(2_000)
    await expect(running).resolves.toEqual({ status: 'rejected', reason: 'closed' })
    await expect(queued).resolves.toEqual({ status: 'rejected', reason: 'closed' })
    expect(pool.stats).toEqual({
      workers: 0,
      starting: 0,
      idle: 0,
      busy: 0,
      stopping: 0,
      queued: 0,
    })
    await expect(pool.run({ op: 'echo', value: 'tarde' })).resolves.toEqual({
      status: 'rejected',
      reason: 'closed',
    })
    await expect(pool.close()).resolves.toBeUndefined()
    await expect(pool.start()).rejects.toThrow(WorkerStartError)
  })

  it('un pool que nadie cierra no mantiene vivo el proceso, con hilos que atendieron o sin estrenar', () => {
    // Node carga este módulo tal cual (quita los tipos): el pool solo importa `node:` en ejecución.
    const poolModule = new URL('./worker-pool.ts', import.meta.url).href
    const source = `
      import { WorkerPool } from ${JSON.stringify(poolModule)}
      const options = (name) => ({
        script: new URL(${JSON.stringify(OPS_WORKER.href)}),
        name, maxWorkers: 2, maxQueued: 4, queueTimeoutMs: 5000, taskTimeoutMs: 5000, maxHeapMb: 64,
      })
      await new WorkerPool(options('sin-estrenar')).start()
      const used = new WorkerPool(options('usado'))
      await used.start()
      console.log(JSON.stringify(await used.run({ op: 'echo', value: 'hola' })))
    `
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
      encoding: 'utf8',
      timeout: 10_000,
    })
    expect(child.error).toBeUndefined()
    expect(child.stderr).toBe('')
    expect(child.status).toBe(0)
    expect(child.stdout.trim()).toBe(JSON.stringify({ status: 'completed', value: 'hola' }))
  })

  it.each([
    [{ maxWorkers: 0 }],
    [{ maxWorkers: 1.5 }],
    [{ maxQueued: 0 }],
    [{ queueTimeoutMs: 0 }],
    [{ taskTimeoutMs: -1 }],
    [{ taskTimeoutMs: 2 ** 31 }],
    [{ maxHeapMb: 0 }],
    [{ maxYoungGenerationMb: 0 }],
    [{ name: '' }],
  ])('rechaza opciones inválidas (%o)', (overrides) => {
    expect(() => createPool(overrides)).toThrow(RangeError)
  })
})
