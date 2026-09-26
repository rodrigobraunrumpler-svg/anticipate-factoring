import {
  Logger,
  type LoggerService,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common'

/** Una tarea de la pasada de mantenimiento. Su resultado solo va al log. */
export type MaintenanceTask = { readonly name: string; run(): Promise<unknown> }

/** Tareas de la pasada, en orden. Las arma `MaintenanceWorkerModule`. */
export const MAINTENANCE_TASKS = Symbol('MAINTENANCE_TASKS')

export type MaintenanceScheduleOptions = {
  /** MAINTENANCE_ENABLED: sin esto no se programa nada (los tests llaman a `runOnce`). */
  readonly enabled: boolean
  /** MAINTENANCE_INTERVAL_MS: espera entre el fin de una pasada y el inicio de la siguiente. */
  readonly intervalMs: number
}

export type MaintenancePassReport = { completed: string[]; failed: string[]; skipped: string[] }

/**
 * Corre las tareas de mantenimiento en orden: una pasada al arrancar y otra `intervalMs` después de
 * que termina la anterior. Es un temporizador encadenado, nunca un intervalo fijo, así que dos
 * pasadas no se solapan. Cada tarea tiene su propio try/catch: una que falla no frena a las demás.
 *
 * Varias réplicas pueden correr la misma pasada a la vez: la baja y la purga filtran por estado en el
 * mismo UPDATE y borrar dos veces un objeto no es un error. No se usa un advisory lock de sesión
 * porque no sobrevive al pooler de Neon en modo transacción.
 *
 * Al apagar (`onModuleDestroy`) deja de programar, no empieza tareas nuevas y espera la que está en
 * curso. El pool de la base se cierra después, en `onApplicationShutdown` de `PrismaService`.
 */
export class MaintenanceScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight: Promise<MaintenancePassReport> | null = null
  private stopping = false

  constructor(
    private readonly options: MaintenanceScheduleOptions,
    private readonly tasks: readonly MaintenanceTask[],
    private readonly logger: Pick<LoggerService, 'log' | 'error'> = new Logger(
      MaintenanceScheduler.name,
    ),
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.enabled) {
      this.logger.log('Mantenimiento desactivado (MAINTENANCE_ENABLED=false).')
      return
    }
    this.scheduleNext(0)
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.inFlight
  }

  /** Corre una pasada ya. Si hay una en curso, devuelve esa misma en vez de empezar otra. */
  runOnce(): Promise<MaintenancePassReport> {
    if (this.inFlight !== null) return this.inFlight
    if (this.stopping) {
      return Promise.resolve({
        completed: [],
        failed: [],
        skipped: this.tasks.map((task) => task.name),
      })
    }
    const pass = this.runPass().finally(() => {
      this.inFlight = null
    })
    this.inFlight = pass
    return pass
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopping) return
    this.timer = setTimeout(() => {
      this.timer = null
      // runPass nunca rechaza: cada tarea atrapa su error.
      void this.runOnce().then(() => this.scheduleNext(this.options.intervalMs))
    }, delayMs)
    // El temporizador nunca mantiene vivo al proceso por sí solo.
    this.timer.unref()
  }

  private async runPass(): Promise<MaintenancePassReport> {
    const report: MaintenancePassReport = { completed: [], failed: [], skipped: [] }
    for (const task of this.tasks) {
      if (this.stopping) {
        report.skipped.push(task.name)
        continue
      }
      try {
        const result = await task.run()
        report.completed.push(task.name)
        this.logger.log({ task: task.name, result }, 'Tarea de mantenimiento terminada.')
      } catch (error) {
        report.failed.push(task.name)
        this.logger.error({ err: error, task: task.name }, 'Falló una tarea de mantenimiento.')
      }
    }
    return report
  }
}
