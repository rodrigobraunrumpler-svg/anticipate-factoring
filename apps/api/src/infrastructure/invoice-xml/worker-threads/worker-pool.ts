import { Worker } from 'node:worker_threads'
import type { WorkerReply, WorkerRequest } from './worker-pool.protocol.js'

export type WorkerPoolOptions = {
  /** Script de cada worker (`file:` o `data:`). Habla el protocolo de `worker-pool.protocol.ts`. */
  readonly script: URL
  /** Nombre de los hilos: aparece en los diagnósticos de Node y en los mensajes de error. */
  readonly name: string
  /** Tope de hilos vivos, contando los que arrancan y los que se están terminando. */
  readonly maxWorkers: number
  /** Tope de tareas esperando un hilo libre. Con la cola llena, `run` responde `queue-full`. */
  readonly maxQueued: number
  /** Tope de espera en la cola. Pasado, la tarea sale de la cola con `queue-timeout`. */
  readonly queueTimeoutMs: number
  /** Tope de una tarea en su hilo, desde que se le entrega. Pasado, el hilo se termina. */
  readonly taskTimeoutMs: number
  /** Tope del heap de cada hilo (generación vieja de V8), en MiB. Pasado, V8 termina el hilo. */
  readonly maxHeapMb: number
  /**
   * Tope de la generación joven de cada hilo, en MiB. Sin él, V8 la dimensiona por su cuenta y la
   * memoria de un hilo puede duplicar `maxHeapMb`.
   */
  readonly maxYoungGenerationMb?: number
  /** Se llama con la causa cuando un worker no llega a arrancar. Para el log de quien usa el pool. */
  readonly onStartFailure?: (error: Error) => void
}

/**
 * Por qué una tarea no llegó a un hilo, o por qué el pool dejó de esperarla (`aborted`: quien la pidió
 * canceló su señal).
 */
export type WorkerPoolRejection =
  | 'queue-full'
  | 'queue-timeout'
  | 'start-failed'
  | 'closed'
  | 'aborted'

/** Cancelación de quien pide la tarea. */
export type WorkerRunOptions = { readonly signal?: AbortSignal | undefined }

/**
 * Cómo terminó una tarea. `timed-out` y `out-of-memory` hablan de la tarea (su hilo se terminó y el
 * pool lo reemplaza); `rejected`, del pool (la tarea nunca corrió). Un defecto (el worker informó una
 * falla, murió sin responder o la entrada no se pudo enviar) rechaza la promesa con `WorkerTaskError`.
 */
export type WorkerTaskOutcome<TOutput> =
  | { readonly status: 'completed'; readonly value: TOutput }
  | { readonly status: 'timed-out' }
  | { readonly status: 'out-of-memory' }
  | { readonly status: 'rejected'; readonly reason: WorkerPoolRejection }

export type WorkerPoolStats = {
  workers: number
  starting: number
  idle: number
  busy: number
  stopping: number
  queued: number
}

/** Un defecto al correr una tarea: el worker informó una falla, murió sin responder o no pudo recibirla. */
export class WorkerTaskError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WorkerTaskError'
  }
}

/** Ningún worker pudo arrancar (el script no carga, o el sistema no puede crear el hilo). */
export class WorkerStartError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WorkerStartError'
  }
}

type Task<TInput, TOutput> = {
  readonly input: TInput
  readonly resolve: (outcome: WorkerTaskOutcome<TOutput>) => void
  readonly reject: (error: Error) => void
  queueTimer: NodeJS.Timeout | undefined
  settled: boolean
  /** Quita el oyente de la señal de quien pidió la tarea. */
  detach: (() => void) | undefined
}

type SlotState = 'starting' | 'idle' | 'busy' | 'stopping'

type Slot<TInput, TOutput> = {
  readonly worker: Worker
  readonly exited: Promise<void>
  state: SlotState
  task: Task<TInput, TOutput> | undefined
  taskId: number
  deadline: NodeJS.Timeout | undefined
  error: Error | undefined
}

const TIMED_OUT = { status: 'timed-out' } as const
const OUT_OF_MEMORY = { status: 'out-of-memory' } as const
const rejected = (reason: WorkerPoolRejection) => ({ status: 'rejected', reason }) as const

/** Mayor plazo que acepta `setTimeout`; uno mayor se dispararía en el acto. */
const MAX_TIMER_MS = 2 ** 31 - 1

function assertPositiveInteger(name: string, value: number, max = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RangeError(`WorkerPool: ${name} debe ser un entero entre 1 y ${max} (${value})`)
  }
}

function settle<TOutput>(
  task: Task<unknown, TOutput>,
  outcome: WorkerTaskOutcome<TOutput> | Error,
): void {
  if (task.settled) return
  task.settled = true
  clearTimeout(task.queueTimer)
  task.queueTimer = undefined
  task.detach?.()
  task.detach = undefined
  if (outcome instanceof Error) task.reject(outcome)
  else task.resolve(outcome)
}

const isOutOfMemory = (error: Error | undefined): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === 'ERR_WORKER_OUT_OF_MEMORY'

/**
 * Pool de `worker_threads` de tamaño fijo con cola FIFO acotada, para trabajo de CPU que no puede
 * correr en el hilo principal (leer un XML hostil). Garantías:
 *
 * - Nunca hay más de `maxWorkers` hilos vivos: un hilo cuenta desde que se crea hasta su `exit`, así
 *   que el reemplazo de uno terminado nace recién cuando el anterior ya no existe.
 * - Nunca hay más de `maxQueued` tareas esperando, y ninguna espera más de `queueTimeoutMs`.
 * - Una tarea corre como mucho `taskTimeoutMs` y su hilo usa como mucho `maxHeapMb` de heap: pasado
 *   cualquiera de los dos, el hilo se termina (`terminate` corta aun un bucle sin fin) y se reemplaza.
 * - Cada tarea se resuelve o rechaza exactamente una vez, también si el plazo y la respuesta llegan
 *   juntos o si el pool se cierra con la tarea en curso.
 * - Una tarea cuya señal se cancela responde `aborted` en el acto: si esperaba, sale de la cola; si ya
 *   corría, su hilo la termina (acotada por `taskTimeoutMs`), el resultado se descarta y el hilo sigue
 *   atendiendo: cancelar no cuesta un hilo nuevo.
 * - Los hilos arrancan a demanda, más uno que `start` deja listo (y el pool repone). Un hilo ocioso
 *   no mantiene vivo el proceso (`unref`); uno que arranca o está ocupado sí, hasta estar listo o
 *   terminar su tarea.
 * - Un worker que no llega a arrancar no se reintenta en bucle: el pool espera a la próxima tarea.
 *
 * Solo importa `node:` en ejecución: Node lo carga igual desde `src` (quitando los tipos) que desde
 * `dist`. Por eso tampoco usa propiedades de parámetro en el constructor.
 */
export class WorkerPool<TInput, TOutput> {
  private readonly options: WorkerPoolOptions
  private readonly slots = new Set<Slot<TInput, TOutput>>()
  private readonly queue: Task<TInput, TOutput>[] = []
  private readonly readyWaiters: { resolve: () => void; reject: (error: Error) => void }[] = []
  private nextTaskId = 0
  private closed = false
  /** Después de `start`, el pool mantiene al menos un hilo vivo o arrancando. */
  private keepWarm = false
  /** Tras un worker que no arrancó, no se crean otros hasta la próxima tarea o `start`. */
  private spawnBlocked = false

  constructor(options: WorkerPoolOptions) {
    assertPositiveInteger('maxWorkers', options.maxWorkers)
    assertPositiveInteger('maxQueued', options.maxQueued)
    assertPositiveInteger('queueTimeoutMs', options.queueTimeoutMs, MAX_TIMER_MS)
    assertPositiveInteger('taskTimeoutMs', options.taskTimeoutMs, MAX_TIMER_MS)
    assertPositiveInteger('maxHeapMb', options.maxHeapMb)
    if (options.maxYoungGenerationMb !== undefined) {
      assertPositiveInteger('maxYoungGenerationMb', options.maxYoungGenerationMb)
    }
    if (options.name.trim() === '') throw new RangeError('WorkerPool: name no puede estar vacío')
    this.options = options
  }

  get stats(): WorkerPoolStats {
    const stats: WorkerPoolStats = {
      workers: this.slots.size,
      starting: 0,
      idle: 0,
      busy: 0,
      stopping: 0,
      queued: this.queue.length,
    }
    for (const slot of this.slots) stats[slot.state] += 1
    return stats
  }

  /**
   * Deja un hilo listo y lo mantiene (si muere, el pool lo repone). Resuelve cuando hay uno listo y
   * rechaza con `WorkerStartError` si ninguno pudo arrancar: así un script que no carga se descubre al
   * arrancar la aplicación y no en la primera solicitud.
   */
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new WorkerStartError('El pool de workers está cerrado'))
    this.keepWarm = true
    if (this.countSlots('idle') + this.countSlots('busy') > 0) return Promise.resolve()
    const ready = new Promise<void>((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject })
    })
    this.spawnBlocked = false
    if (this.countSlots('starting') === 0) this.spawn()
    return ready
  }

  /**
   * Corre una tarea en un hilo libre o la deja en la cola. Nunca rechaza por la tarea: ver
   * `WorkerTaskOutcome`. Con `signal` cancelada responde `aborted` en el acto.
   */
  run(input: TInput, options: WorkerRunOptions = {}): Promise<WorkerTaskOutcome<TOutput>> {
    const { signal } = options
    if (this.closed) return Promise.resolve(rejected('closed'))
    if (signal?.aborted) return Promise.resolve(rejected('aborted'))
    return new Promise((resolve, reject) => {
      const task: Task<TInput, TOutput> = {
        input,
        resolve,
        reject,
        queueTimer: undefined,
        settled: false,
        detach: undefined,
      }
      if (signal !== undefined) {
        const onAbort = () => this.abort(task)
        signal.addEventListener('abort', onAbort, { once: true })
        task.detach = () => signal.removeEventListener('abort', onAbort)
      }
      // Un hilo libre solo existe con la cola vacía (`fill` la vacía en cuanto uno se libera): el
      // orden de llegada se respeta.
      const idle = this.findSlot('idle')
      if (idle !== undefined) {
        this.dispatch(idle, task)
        return
      }
      if (this.queue.length >= this.options.maxQueued) {
        settle(task, rejected('queue-full'))
        return
      }
      task.queueTimer = setTimeout(() => this.expire(task), this.options.queueTimeoutMs)
      this.queue.push(task)
      this.spawnBlocked = false
      this.fill()
    })
  }

  /**
   * Termina todos los hilos y espera su salida. Lo que estaba en la cola o en curso responde
   * `closed`, igual que todo `run` posterior. Se puede llamar más de una vez.
   */
  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      for (const task of this.queue.splice(0)) settle(task, rejected('closed'))
      const error = new WorkerStartError('El pool de workers se cerró antes de tener uno listo')
      for (const waiter of this.readyWaiters.splice(0)) waiter.reject(error)
      for (const slot of this.slots) this.stop(slot, rejected('closed'))
    }
    await Promise.all(Array.from(this.slots, (slot) => slot.exited))
  }

  private countSlots(state: SlotState): number {
    let count = 0
    for (const slot of this.slots) if (slot.state === state) count += 1
    return count
  }

  private findSlot(state: SlotState): Slot<TInput, TOutput> | undefined {
    for (const slot of this.slots) if (slot.state === state) return slot
    return undefined
  }

  private spawn(): void {
    let worker: Worker
    try {
      const { maxHeapMb, maxYoungGenerationMb } = this.options
      worker = new Worker(this.options.script, {
        name: this.options.name,
        resourceLimits: {
          maxOldGenerationSizeMb: maxHeapMb,
          ...(maxYoungGenerationMb === undefined
            ? {}
            : { maxYoungGenerationSizeMb: maxYoungGenerationMb }),
        },
      })
    } catch (error) {
      this.onStartFailure(error instanceof Error ? error : new Error(String(error)))
      return
    }
    let markExited: () => void = () => undefined
    const exited = new Promise<void>((resolve) => {
      markExited = resolve
    })
    const slot: Slot<TInput, TOutput> = {
      worker,
      exited,
      state: 'starting',
      task: undefined,
      taskId: 0,
      deadline: undefined,
      error: undefined,
    }
    this.slots.add(slot)
    worker.on('message', (message: WorkerReply<TOutput>) => this.onMessage(slot, message))
    worker.on('messageerror', (error: Error) => {
      // Una respuesta que no se pudo deserializar: el hilo queda en un estado dudoso y se reemplaza.
      this.stop(
        slot,
        new WorkerTaskError('El worker envió una respuesta ilegible', { cause: error }),
      )
    })
    // Una excepción sin atrapar o el tope de memoria: llega antes que `exit`, que decide qué hacer.
    worker.on('error', (error: Error) => {
      slot.error ??= error
    })
    worker.once('exit', (exitCode: number) => {
      this.onExit(slot, exitCode)
      markExited()
    })
  }

  private dispatch(slot: Slot<TInput, TOutput>, task: Task<TInput, TOutput>): void {
    const id = ++this.nextTaskId
    try {
      slot.worker.postMessage({ id, input: task.input } satisfies WorkerRequest<TInput>)
    } catch (error) {
      // La entrada no se puede clonar (DataCloneError): un defecto de quien llama. El hilo sigue libre.
      settle(task, new WorkerTaskError('La tarea no se pudo enviar al worker', { cause: error }))
      return
    }
    clearTimeout(task.queueTimer)
    task.queueTimer = undefined
    slot.state = 'busy'
    slot.task = task
    slot.taskId = id
    slot.worker.ref()
    slot.deadline = setTimeout(() => this.stop(slot, TIMED_OUT), this.options.taskTimeoutMs)
  }

  private onMessage(slot: Slot<TInput, TOutput>, message: WorkerReply<TOutput>): void {
    if (message.kind === 'ready') {
      if (slot.state !== 'starting') return
      slot.state = 'idle'
      // Mientras arranca, el hilo mantiene vivo el proceso (alguien puede estar esperándolo en `start`
      // o en la cola); ocioso, no. Aquí y no al crearlo: agregar el oyente de 'message' vuelve a
      // referenciar el puerto del worker.
      slot.worker.unref()
      this.spawnBlocked = false
      for (const waiter of this.readyWaiters.splice(0)) waiter.resolve()
      this.fill()
      return
    }
    // Una respuesta que llega después del plazo (el hilo ya se está terminando) no cuenta.
    const task = slot.task
    if (slot.state !== 'busy' || task === undefined || message.id !== slot.taskId) return
    clearTimeout(slot.deadline)
    slot.deadline = undefined
    slot.task = undefined
    slot.state = 'idle'
    slot.worker.unref()
    settle(
      task,
      message.kind === 'result'
        ? { status: 'completed', value: message.value }
        : new WorkerTaskError(`El worker ${this.options.name} falló: ${message.message}`),
    )
    this.fill()
  }

  /** Termina el hilo de `slot` y resuelve su tarea, si tiene, con `outcome`. */
  private stop(slot: Slot<TInput, TOutput>, outcome: WorkerTaskOutcome<TOutput> | Error): void {
    clearTimeout(slot.deadline)
    slot.deadline = undefined
    const task = slot.task
    slot.task = undefined
    if (task !== undefined) settle(task, outcome)
    if (slot.state === 'stopping') return
    slot.state = 'stopping'
    // `terminate` corta también código que no suelta el hilo; el `exit` que sigue lo saca del pool.
    void slot.worker.terminate()
  }

  private onExit(slot: Slot<TInput, TOutput>, exitCode: number): void {
    this.slots.delete(slot)
    clearTimeout(slot.deadline)
    slot.deadline = undefined
    const task = slot.task
    slot.task = undefined
    if (task !== undefined) {
      settle(
        task,
        isOutOfMemory(slot.error)
          ? OUT_OF_MEMORY
          : new WorkerTaskError(
              `El worker ${this.options.name} terminó (código ${exitCode}) sin responder`,
              { cause: slot.error },
            ),
      )
    }
    if (slot.state === 'starting') {
      this.onStartFailure(
        slot.error ?? new Error(`El worker salió con código ${exitCode} antes de estar listo`),
      )
    }
    this.fill()
  }

  private onStartFailure(cause: Error): void {
    this.spawnBlocked = true
    this.options.onStartFailure?.(cause)
    // Si queda otro hilo (listo, ocupado o arrancando), él atiende la cola y a quien espera en `start`.
    for (const slot of this.slots) if (slot.state !== 'stopping') return
    const error = new WorkerStartError(`El worker ${this.options.name} no arrancó`, { cause })
    for (const waiter of this.readyWaiters.splice(0)) waiter.reject(error)
    for (const task of this.queue.splice(0)) settle(task, rejected('start-failed'))
  }

  /** Quien pidió la tarea ya no la espera: sale de la cola o, si corre, su resultado se descarta. */
  private abort(task: Task<TInput, TOutput>): void {
    const index = this.queue.indexOf(task)
    if (index !== -1) this.queue.splice(index, 1)
    settle(task, rejected('aborted'))
  }

  private expire(task: Task<TInput, TOutput>): void {
    const index = this.queue.indexOf(task)
    if (index === -1) return
    this.queue.splice(index, 1)
    settle(task, rejected('queue-timeout'))
  }

  /** Entrega la cola a los hilos libres y crea los que falten, sin pasar de `maxWorkers`. */
  private fill(): void {
    if (this.closed) return
    for (const slot of this.slots) {
      while (slot.state === 'idle' && this.queue.length > 0) {
        this.dispatch(slot, this.queue.shift() as Task<TInput, TOutput>)
      }
    }
    if (this.spawnBlocked) return
    const missing = Math.min(
      this.queue.length - this.countSlots('starting'),
      this.options.maxWorkers - this.slots.size,
    )
    for (let created = 0; created < missing; created++) this.spawn()
    if (this.keepWarm && this.slots.size === 0) this.spawn()
  }
}
