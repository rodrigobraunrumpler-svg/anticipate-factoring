import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { Logger, type LoggerService } from '@nestjs/common'

/** Lo que tiene abierto el servidor HTTP: conexiones y peticiones que todavía no terminaron. */
export type HttpServerLoad = { readonly connections: number; readonly requests: number }

/**
 * Drena el servidor HTTP sin depender de los clientes. `server.close()` de Node deja de aceptar
 * conexiones y cierra las ociosas, pero una conexión keep-alive que estaba atendiendo una petición
 * sigue abierta al responder y acepta peticiones nuevas: un proxy o un navegador que la reusa mantiene
 * vivo el servidor para siempre y cada despliegue con tráfico termina en SIGKILL. Mientras drena, cada
 * respuesta sale con `Connection: close` (también la de una petición que termina de llegar por una
 * conexión ya abierta), así cada conexión se cierra al responder su petición en curso.
 *
 * Se crea antes de `listen`: sigue las conexiones y las peticiones desde la primera.
 */
export class HttpServerDrain {
  private readonly sockets = new Set<Socket>()
  private readonly pending = new Set<ServerResponse>()
  private drained: Promise<void> | undefined

  constructor(private readonly server: Server) {
    server.on('connection', (socket: Socket) => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    })
    // Antes que Express: la cabecera queda puesta aunque la ruta responda en el mismo turno.
    server.prependListener('request', (_request: IncomingMessage, response: ServerResponse) => {
      this.pending.add(response)
      response.once('close', () => this.pending.delete(response))
      if (this.drained !== undefined) this.closeConnectionAfter(response)
    })
  }

  get load(): HttpServerLoad {
    return { connections: this.sockets.size, requests: this.pending.size }
  }

  /**
   * Deja de aceptar conexiones, cierra en el acto las ociosas y pide cerrar cada una de las demás al
   * terminar su respuesta. Resuelve cuando el servidor ya no tiene conexiones. Llamarla otra vez
   * devuelve la misma promesa.
   */
  drain(): Promise<void> {
    if (this.drained === undefined) {
      this.drained = new Promise<void>((resolve) => {
        // Con el servidor sin escuchar, el callback recibe ERR_SERVER_NOT_RUNNING: igual terminó.
        this.server.close(() => resolve())
      })
      this.server.closeIdleConnections()
      for (const response of this.pending) this.closeConnectionAfter(response)
    }
    return this.drained
  }

  /** Corta todas las conexiones que quedan, con o sin una petición en curso. Devuelve qué cortó. */
  destroyAll(): HttpServerLoad {
    const load = this.load
    this.server.closeAllConnections()
    for (const socket of this.sockets) socket.destroy()
    return load
  }

  private closeConnectionAfter(response: ServerResponse): void {
    if (!response.headersSent) {
      // Node cierra la conexión al terminar una respuesta con esta cabecera.
      response.setHeader('Connection', 'close')
      return
    }
    // Las cabeceras ya salieron con keep-alive: al terminar, la conexión queda ociosa y se cierra.
    response.once('finish', () => setImmediate(() => this.server.closeIdleConnections()))
  }
}

export type GracefulShutdownOptions = {
  /** `SHUTDOWN_TIMEOUT_MS`: tope desde la señal hasta la salida. */
  readonly timeoutMs: number
  /**
   * Cierra la aplicación: en la API, `app.close()` (los workers terminan su pasada; después se cierran
   * el lector de XML, el almacenamiento y la base). Corre mientras el servidor drena.
   */
  readonly closeApp: () => Promise<void>
  /** Termina el proceso: `process.exit` en la API. */
  readonly exit: (code: number) => void
  readonly logger?: Pick<LoggerService, 'log' | 'error'>
}

/**
 * Apagado ordenado con plazo (D56). Ante la señal, el servidor HTTP drena (`HttpServerDrain`) mientras
 * Nest cierra la aplicación: los workers terminan su pasada y el servidor espera las respuestas en
 * curso antes de que se cierren la base y el almacenamiento. Si todo termina, el proceso sale con 0.
 * Si vence `timeoutMs`, corta las conexiones que quedan y sale con 1, con un log de error que dice qué
 * cortó; lo cortado lo recuperan el outbox (arriendo), el barrido de huérfanos y el reintento
 * idempotente del proveedor. Una segunda señal durante el apagado corta en el acto.
 */
export class GracefulShutdown {
  private readonly logger: Pick<LoggerService, 'log' | 'error'>
  private started = false
  private exited = false
  private deadline: NodeJS.Timeout | undefined

  constructor(
    private readonly drain: HttpServerDrain,
    private readonly options: GracefulShutdownOptions,
  ) {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
      throw new RangeError(`El plazo del apagado debe ser un entero positivo: ${options.timeoutMs}`)
    }
    this.logger = options.logger ?? new Logger(GracefulShutdown.name)
  }

  /** Apaga ante cada una de `signals`. Devuelve cómo dejar de escucharlas. */
  listen(signals: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT']): () => void {
    const onSignal = (signal: NodeJS.Signals) => {
      void this.shutdown(signal)
    }
    for (const signal of signals) process.on(signal, onSignal)
    return () => {
      for (const signal of signals) process.off(signal, onSignal)
    }
  }

  /** Apaga una vez; una segunda llamada mientras tanto corta en el acto. Nunca rechaza. */
  async shutdown(reason: string): Promise<void> {
    if (this.started) {
      this.force(`llegó ${reason} con el apagado en curso`)
      return
    }
    this.started = true
    const startedAt = Date.now()
    const { timeoutMs } = this.options
    const { connections, requests } = this.drain.load
    this.logger.log(
      `Apagado por ${reason}: la API deja de aceptar conexiones, cierra las ociosas y espera ${requests} peticiones en curso y ${connections} conexiones abiertas, como mucho ${timeoutMs} ms (SHUTDOWN_TIMEOUT_MS)`,
    )
    this.deadline = setTimeout(
      () => this.force(`venció el plazo de ${timeoutMs} ms (SHUTDOWN_TIMEOUT_MS)`),
      timeoutMs,
    )
    try {
      const drained = this.drain.drain()
      await this.options.closeApp()
      await drained
    } catch (error) {
      if (this.exited) return
      this.logger.error({ err: error }, 'Falló el apagado: el proceso sale con código 1')
      this.exit(1)
      return
    }
    if (this.exited) return
    this.logger.log(`Apagado completo en ${Date.now() - startedAt} ms`)
    this.exit(0)
  }

  private force(why: string): void {
    if (this.exited) return
    const cut = this.drain.destroyAll()
    this.logger.error(
      `El apagado no terminó: ${why}. Se cortan ${cut.connections} conexiones (${cut.requests} con una petición sin responder) y el proceso sale con código 1`,
    )
    this.exit(1)
  }

  private exit(code: number): void {
    this.exited = true
    clearTimeout(this.deadline)
    this.options.exit(code)
  }
}
