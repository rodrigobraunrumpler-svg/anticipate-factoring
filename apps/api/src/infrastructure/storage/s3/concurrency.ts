/**
 * Semáforo FIFO: como mucho `limit` tareas a la vez; las demás esperan en orden de llegada. Un
 * cupo se libera cuando la tarea termina, resuelva o rechace, y pasa directo a la siguiente en espera.
 * Una tarea que espera cupo con una `signal` que se cancela sale de la espera y rechaza con su motivo,
 * sin correr; una que ya tiene cupo no se corta: la señal es asunto de la tarea.
 */
export class ConcurrencyLimiter {
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`El tope de concurrencia debe ser un entero positivo: ${limit}`)
    }
  }

  /** Tareas en curso con cupo; nunca pasa de `limit`. */
  get running(): number {
    return this.active
  }

  /** Tareas que esperan un cupo. */
  get pending(): number {
    return this.waiting.length
  }

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal)
    try {
      return await task()
    } finally {
      this.release()
    }
  }

  private acquire(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (this.active < this.limit) {
      this.active += 1
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const granted = () => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = () => {
        const index = this.waiting.indexOf(granted)
        if (index !== -1) this.waiting.splice(index, 1)
        reject(signal?.reason)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiting.push(granted)
    })
  }

  private release(): void {
    const next = this.waiting.shift()
    // El cupo pasa a la siguiente sin volver a contarse: `active` no cambia.
    if (next !== undefined) next()
    else this.active -= 1
  }
}

/**
 * Recorre `items` con como mucho `concurrency` tareas a la vez, tomando los elementos en orden. Espera
 * a que terminen todas antes de resolver: nunca deja una tarea en curso. Si alguna rechaza, las demás
 * siguen hasta vaciar la lista y al final rechaza con el primer error.
 */
export async function forEachConcurrently<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`La concurrencia debe ser un entero positivo: ${concurrency}`)
  }
  let next = 0
  const errors: unknown[] = []
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next
      next += 1
      try {
        await task(items[index] as T, index)
      } catch (error) {
        errors.push(error)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  if (errors.length > 0) throw errors[0]
}
