import { createServer, type Server, type ServerResponse } from 'node:http'
import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GracefulShutdown, HttpServerDrain } from './graceful-shutdown.js'

type RawClient = {
  readonly socket: Socket
  /** Todo lo que llegó por la conexión, con los saltos de línea de HTTP. */
  received(): string
  /** Resuelve cuando la conexión se cierra, con los milisegundos desde `since`. */
  readonly closed: Promise<void>
}

const servers: Server[] = []
const clients: Socket[] = []

afterEach(async () => {
  for (const socket of clients.splice(0)) socket.destroy()
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    ),
  )
})

/**
 * Servidor de prueba: `/fast` responde en el acto; `/slow` espera a `release()`. Las respuestas lentas
 * quedan en `slow` para que el test decida cuándo terminan.
 */
async function startServer() {
  const slow: ServerResponse[] = []
  const server = createServer((req, res) => {
    if (req.url === '/slow') {
      slow.push(res)
      return
    }
    res.end('rápido')
  })
  // Como el de la API: el keep-alive supera al del proxy (65 s).
  server.keepAliveTimeout = 65_000
  const drain = new HttpServerDrain(server)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('sin puerto')
  const release = () => {
    for (const res of slow.splice(0)) res.end('lento')
  }
  return { server, drain, port: address.port, slow, release }
}

function rawClient(port: number): RawClient {
  const socket = connect(port, '127.0.0.1')
  clients.push(socket)
  let data = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    data += chunk
  })
  socket.on('error', () => undefined)
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
  return { socket, received: () => data, closed }
}

const request = (path: string) => `GET ${path} HTTP/1.1\r\nHost: prueba\r\n\r\n`

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('la condición no se cumplió a tiempo')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** Resuelve con `true` si la promesa termina antes de `ms`, con `false` si no. */
function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ])
}

describe('HttpServerDrain', () => {
  it('sin drenar, Node deja abierta la conexión keep-alive de una petición en curso (el defecto que corrige)', async () => {
    const { server, port, slow, release } = await startServer()
    const client = rawClient(port)
    client.socket.write(request('/slow'))
    await until(() => slow.length === 1)
    server.close()
    release()
    await until(() => client.received().includes('lento'))
    expect(client.received()).toMatch(/Connection: keep-alive/i)
    expect(await settlesWithin(client.closed, 200)).toBe(false)
  })

  it('cierra en el acto una conexión keep-alive ociosa', async () => {
    const { drain, port } = await startServer()
    const client = rawClient(port)
    client.socket.write(request('/fast'))
    await until(() => client.received().includes('rápido'))
    expect(drain.load).toEqual({ connections: 1, requests: 0 })

    const drained = drain.drain()
    expect(await settlesWithin(client.closed, 200)).toBe(true)
    expect(await settlesWithin(drained, 200)).toBe(true)
  })

  it('la petición en curso termina con Connection: close y su conexión se cierra al responder', async () => {
    const { drain, port, slow, release } = await startServer()
    const client = rawClient(port)
    client.socket.write(request('/slow'))
    await until(() => slow.length === 1)
    expect(drain.load).toEqual({ connections: 1, requests: 1 })

    const drained = drain.drain()
    expect(await settlesWithin(drained, 100)).toBe(false)
    release()
    await client.closed
    expect(client.received()).toMatch(/^HTTP\/1\.1 200 OK/)
    expect(client.received()).toMatch(/Connection: close/i)
    expect(client.received()).toContain('lento')
    expect(await settlesWithin(drained, 200)).toBe(true)
  })

  it('una petición que termina de llegar por una conexión abierta mientras drena también sale con Connection: close', async () => {
    const { drain, port } = await startServer()
    const client = rawClient(port)
    // Cabeceras a medias: la conexión no está ociosa y el cierre de las ociosas no la toca.
    client.socket.write('GET /fast HTTP/1.1\r\nHost: prueba\r\n')
    await until(() => drain.load.connections === 1)
    const drained = drain.drain()
    await new Promise((resolve) => setTimeout(resolve, 50))
    client.socket.write('\r\n')
    await client.closed
    expect(client.received()).toMatch(/Connection: close/i)
    expect(client.received()).toContain('rápido')
    expect(await settlesWithin(drained, 200)).toBe(true)
  })

  it('una respuesta con las cabeceras ya enviadas cierra su conexión al terminar', async () => {
    const { drain, port, slow } = await startServer()
    const client = rawClient(port)
    client.socket.write(request('/slow'))
    await until(() => slow.length === 1)
    const res = slow[0] as ServerResponse
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.write('parte ')
    await until(() => client.received().includes('parte'))

    const drained = drain.drain()
    res.end('final')
    await client.closed
    expect(client.received()).toContain('final')
    expect(await settlesWithin(drained, 200)).toBe(true)
  })

  it('destroyAll corta lo que queda y dice cuántas conexiones y peticiones había', async () => {
    const { drain, port, slow } = await startServer()
    const busy = rawClient(port)
    busy.socket.write(request('/slow'))
    const idle = rawClient(port)
    idle.socket.write('GET /fast HTTP/1.1\r\nHost: pru')
    await until(() => slow.length === 1 && drain.load.connections === 2)

    void drain.drain()
    expect(drain.destroyAll()).toEqual({ connections: 2, requests: 1 })
    await Promise.all([busy.closed, idle.closed])
    expect(busy.received()).toBe('')
  })
})

describe('GracefulShutdown', () => {
  function logger() {
    return { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
  }

  it('drena, cierra la app y sale con 0 antes del plazo, con un log al empezar y otro al terminar', async () => {
    const { drain, port, slow, release } = await startServer()
    const idle = rawClient(port)
    idle.socket.write(request('/fast'))
    const busy = rawClient(port)
    busy.socket.write(request('/slow'))
    await until(() => idle.received().includes('rápido') && slow.length === 1)

    const log = logger()
    const exit = vi.fn()
    const closeApp = vi.fn(async () => undefined)
    const shutdown = new GracefulShutdown(drain, { timeoutMs: 5_000, closeApp, exit, logger: log })
    const done = shutdown.shutdown('SIGTERM')
    expect(await settlesWithin(idle.closed, 200)).toBe(true)
    expect(exit).not.toHaveBeenCalled()

    release()
    await done
    await busy.closed
    expect(busy.received()).toMatch(/Connection: close/i)
    expect(closeApp).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledExactlyOnceWith(0)
    expect(log.log).toHaveBeenCalledWith(
      expect.stringMatching(
        /^Apagado por SIGTERM: .*1 peticiones en curso y 2 conexiones abiertas.*5000 ms \(SHUTDOWN_TIMEOUT_MS\)/,
      ),
    )
    expect(log.log).toHaveBeenLastCalledWith(expect.stringMatching(/^Apagado completo en \d+ ms$/))
    expect(log.error).not.toHaveBeenCalled()
  })

  it('al vencer el plazo corta las conexiones y sale con 1, con un log de error que dice qué cortó', async () => {
    const { drain, port, slow } = await startServer()
    const busy = rawClient(port)
    busy.socket.write(request('/slow'))
    await until(() => slow.length === 1)

    const log = logger()
    const exit = vi.fn()
    const shutdown = new GracefulShutdown(drain, {
      timeoutMs: 150,
      closeApp: async () => undefined,
      exit,
      logger: log,
    })
    const startedAt = Date.now()
    void shutdown.shutdown('SIGTERM')
    await until(() => exit.mock.calls.length > 0)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(140)
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
    expect(log.error).toHaveBeenCalledExactlyOnceWith(
      'El apagado no terminó: venció el plazo de 150 ms (SHUTDOWN_TIMEOUT_MS). Se cortan 1 conexiones (1 con una petición sin responder) y el proceso sale con código 1',
    )
    await busy.closed
    expect(busy.received()).toBe('')
  })

  it('el cierre de la app también cuenta para el plazo', async () => {
    const { drain } = await startServer()
    const exit = vi.fn()
    const shutdown = new GracefulShutdown(drain, {
      timeoutMs: 100,
      closeApp: () => new Promise<void>(() => undefined),
      exit,
      logger: logger(),
    })
    void shutdown.shutdown('SIGTERM')
    await until(() => exit.mock.calls.length > 0)
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('si el cierre de la app falla: log de error y sale con 1', async () => {
    const { drain } = await startServer()
    const log = logger()
    const exit = vi.fn()
    const failure = new Error('falló un hook')
    const shutdown = new GracefulShutdown(drain, {
      timeoutMs: 5_000,
      closeApp: async () => {
        throw failure
      },
      exit,
      logger: log,
    })
    await shutdown.shutdown('SIGTERM')
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
    expect(log.error).toHaveBeenCalledWith(
      { err: failure },
      'Falló el apagado: el proceso sale con código 1',
    )
  })

  it('una segunda señal durante el apagado corta en el acto', async () => {
    const { drain, port, slow } = await startServer()
    const busy = rawClient(port)
    busy.socket.write(request('/slow'))
    await until(() => slow.length === 1)
    const log = logger()
    const exit = vi.fn()
    const shutdown = new GracefulShutdown(drain, {
      timeoutMs: 5_000,
      closeApp: async () => undefined,
      exit,
      logger: log,
    })
    void shutdown.shutdown('SIGTERM')
    await shutdown.shutdown('SIGINT')
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
    expect(log.error).toHaveBeenCalledWith(
      expect.stringMatching(/^El apagado no terminó: llegó SIGINT con el apagado en curso\./),
    )
    await busy.closed
  })

  it('listen apaga con cada señal pedida y devuelve cómo dejar de escuchar', async () => {
    const { drain } = await startServer()
    const exit = vi.fn()
    const shutdown = new GracefulShutdown(drain, {
      timeoutMs: 5_000,
      closeApp: async () => undefined,
      exit,
      logger: logger(),
    })
    const spy = vi.spyOn(shutdown, 'shutdown')
    const stop = shutdown.listen(['SIGUSR2'])
    try {
      process.emit('SIGUSR2', 'SIGUSR2')
      await until(() => exit.mock.calls.length > 0)
      expect(spy).toHaveBeenCalledWith('SIGUSR2')
      expect(exit).toHaveBeenCalledExactlyOnceWith(0)
    } finally {
      stop()
    }
    expect(process.listenerCount('SIGUSR2')).toBe(0)
  })

  it('rechaza un plazo que no es un entero positivo', async () => {
    const { drain } = await startServer()
    for (const timeoutMs of [0, -1, 1.5, Number.NaN]) {
      expect(
        () =>
          new GracefulShutdown(drain, {
            timeoutMs,
            closeApp: async () => undefined,
            exit: () => undefined,
          }),
      ).toThrow(RangeError)
    }
  })
})
