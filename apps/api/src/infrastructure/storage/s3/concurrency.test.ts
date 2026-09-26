import { describe, expect, it } from 'vitest'
import { ConcurrencyLimiter, forEachConcurrently } from './concurrency.js'

function deferred<T = void>() {
  let resolve: (value: T) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('ConcurrencyLimiter: cancelación', () => {
  it('una tarea que espera cupo sale de la espera al cancelarse su señal, sin correr', async () => {
    const limiter = new ConcurrencyLimiter(1)
    const gate = deferred()
    const first = limiter.run(() => gate.promise)
    const controller = new AbortController()
    let ran = false
    const waiting = limiter.run(async () => {
      ran = true
    }, controller.signal)
    await tick()
    expect(limiter.pending).toBe(1)

    const reason = new Error('plazo del envío')
    controller.abort(reason)
    await expect(waiting).rejects.toBe(reason)
    expect(limiter.pending).toBe(0)
    gate.resolve()
    await first
    await tick()
    expect(ran).toBe(false)
    expect(limiter.running).toBe(0)
  })

  it('con la señal ya cancelada rechaza sin tomar cupo', async () => {
    const limiter = new ConcurrencyLimiter(1)
    const controller = new AbortController()
    const reason = new Error('ya vencido')
    controller.abort(reason)
    let ran = false
    await expect(
      limiter.run(async () => {
        ran = true
      }, controller.signal),
    ).rejects.toBe(reason)
    expect(ran).toBe(false)
    expect(limiter.running).toBe(0)
  })

  it('una tarea que ya tiene cupo no se corta por la señal: termina y libera su cupo', async () => {
    const limiter = new ConcurrencyLimiter(1)
    const controller = new AbortController()
    const gate = deferred()
    const running = limiter.run(async () => {
      await gate.promise
      return 'terminó'
    }, controller.signal)
    await tick()
    controller.abort(new Error('plazo'))
    gate.resolve()
    await expect(running).resolves.toBe('terminó')
    expect(limiter.running).toBe(0)
  })
})

describe('ConcurrencyLimiter', () => {
  it('nunca corre más tareas que el tope y atiende la espera en orden de llegada', async () => {
    const limiter = new ConcurrencyLimiter(2)
    const gates = [deferred(), deferred(), deferred(), deferred()]
    const started: number[] = []
    const runs = gates.map((gate, index) =>
      limiter.run(async () => {
        started.push(index)
        await gate.promise
      }),
    )

    await tick()
    expect(started).toEqual([0, 1])
    expect(limiter.running).toBe(2)
    expect(limiter.pending).toBe(2)

    gates[1]?.resolve()
    await tick()
    expect(started).toEqual([0, 1, 2])
    expect(limiter.running).toBe(2)

    gates[0]?.resolve()
    gates[2]?.resolve()
    gates[3]?.resolve()
    await Promise.all(runs)
    expect(started).toEqual([0, 1, 2, 3])
    expect(limiter.running).toBe(0)
    expect(limiter.pending).toBe(0)
  })

  it('libera el cupo aunque la tarea rechace y propaga el error', async () => {
    const limiter = new ConcurrencyLimiter(1)
    const failure = new Error('falló')

    await expect(limiter.run(() => Promise.reject(failure))).rejects.toBe(failure)
    await expect(limiter.run(() => Promise.resolve('siguiente'))).resolves.toBe('siguiente')
    expect(limiter.running).toBe(0)
  })

  it('rechaza un tope que no es un entero positivo', () => {
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new ConcurrencyLimiter(limit)).toThrow(RangeError)
    }
  })
})

describe('forEachConcurrently', () => {
  it('toma los elementos en orden con como mucho `concurrency` tareas a la vez', async () => {
    let running = 0
    let maxRunning = 0
    const seen: Array<[string, number]> = []

    await forEachConcurrently(['a', 'b', 'c', 'd', 'e'], 2, async (item, index) => {
      seen.push([item, index])
      running += 1
      maxRunning = Math.max(maxRunning, running)
      await tick()
      running -= 1
    })

    expect(maxRunning).toBe(2)
    expect(seen).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
      ['d', 3],
      ['e', 4],
    ])
  })

  it('si una tarea rechaza, termina las demás y rechaza al final con el primer error', async () => {
    const first = new Error('primero')
    const done: string[] = []
    let settled = false
    const slow = deferred()

    const result = forEachConcurrently(['a', 'b', 'c'], 2, async (item) => {
      if (item === 'a') {
        await slow.promise
        done.push(item)
        return
      }
      if (item === 'b') throw first
      done.push(item)
    }).finally(() => {
      settled = true
    })

    await tick()
    expect(done).toEqual(['c'])
    expect(settled).toBe(false)

    slow.resolve()
    await expect(result).rejects.toBe(first)
    expect(done).toEqual(['c', 'a'])
  })

  it('con una lista vacía no corre nada y rechaza una concurrencia inválida', async () => {
    let calls = 0
    await forEachConcurrently([], 4, async () => {
      calls += 1
    })
    expect(calls).toBe(0)
    await expect(forEachConcurrently(['a'], 0, async () => {})).rejects.toThrow(RangeError)
  })
})
