import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { connect, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { testEnv } from '../support/config.js'
import { createTestPrisma, truncateAll } from '../support/db.js'
import { createPayer } from '../support/factories.js'

/**
 * El apagado de verdad (D56): la API compilada (`node dist/main.js`) en un proceso aparte contra
 * `anticipate_test`, con clientes HTTP crudos para ver las conexiones. Una petición queda en curso
 * con `LOCK TABLE payers`: `GET /api/v1/payers` espera el candado hasta que el test lo suelta (o hasta
 * el `lock_timeout` de 5 s de la base).
 */

const API_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const MAIN = join(API_ROOT, 'dist', 'main.js')
const db = createTestPrisma()

type RunningApi = {
  readonly child: ChildProcess
  readonly port: number
  readonly exited: Promise<{ code: number | null; at: number }>
  output(): string
}

type RawClient = {
  readonly socket: Socket
  received(): string
  readonly closed: Promise<number>
}

const apis: RunningApi[] = []
const clients: Socket[] = []
const locks: Array<() => void> = []
const workDirs: string[] = []

/** El `.ts` más nuevo de `src` (sin tests) contra `dist/main.js`: compila si `dist` quedó atrás. */
function ensureFreshBuild(): void {
  const newest = (dir: string): number =>
    readdirSync(dir, { withFileTypes: true }).reduce((latest, entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return Math.max(latest, newest(path))
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return latest
      return Math.max(latest, statSync(path).mtimeMs)
    }, 0)
  const built = existsSync(MAIN) ? statSync(MAIN).mtimeMs : 0
  if (built >= newest(join(API_ROOT, 'src'))) return
  execFileSync('pnpm', ['exec', 'nest', 'build'], {
    cwd: API_ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
  })
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

async function waitFor<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
  detail = () => '',
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what}: no pasó en ${ms} ms. ${detail()}`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function until(condition: () => Promise<boolean> | boolean, ms: number, what: string) {
  const deadline = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`${what}: no pasó en ${ms} ms`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/**
 * La API compilada con el entorno de prueba y `overrides`, en una carpeta vacía: fuera de producción
 * `main.ts` carga el `.env` de su carpeta de trabajo, y el de `apps/api` apunta a la base de
 * desarrollo. Solo hereda `PATH`.
 */
async function startApi(overrides: Record<string, string>): Promise<RunningApi> {
  const port = await freePort()
  const env: Record<string, string> = { PATH: process.env.PATH ?? '' }
  for (const [key, value] of Object.entries(
    testEnv({ PORT: String(port), LOG_LEVEL: 'info', ...overrides }),
  )) {
    if (value !== undefined) env[key] = value
  }
  const cwd = mkdtempSync(join(tmpdir(), 'anticipate-apagado-'))
  workDirs.push(cwd)
  const child = spawn(process.execPath, [MAIN], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk
  })
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk
  })
  const exited = new Promise<{ code: number | null; at: number }>((resolve) => {
    child.once('exit', (code) => resolve({ code, at: Date.now() }))
  })
  const api: RunningApi = { child, port, exited, output: () => output }
  apis.push(api)
  await until(
    async () => {
      if (child.exitCode !== null) throw new Error(`la API salió al arrancar:\n${output}`)
      try {
        return (await fetch(`http://127.0.0.1:${port}/health`)).status === 200
      } catch {
        return false
      }
    },
    20_000,
    'la API responde /health',
  )
  return api
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
  const closed = new Promise<number>((resolve) => socket.once('close', () => resolve(Date.now())))
  return { socket, received: () => data, closed }
}

const get = (path: string) => `GET ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`

/** Toma `payers` en modo exclusivo hasta `release()`: las lecturas de la API esperan el candado. */
async function lockPayers(): Promise<{ release: () => void; done: Promise<unknown> }> {
  let release: () => void = () => undefined
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  locks.push(release)
  let markLocked: () => void = () => undefined
  const locked = new Promise<void>((resolve) => {
    markLocked = resolve
  })
  const done = db.prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe('LOCK TABLE payers IN ACCESS EXCLUSIVE MODE')
      markLocked()
      await released
    },
    { timeout: 25_000, maxWait: 5_000 },
  )
  await locked
  return { release, done }
}

/** Una consulta de la API espera el candado de `payers`. */
async function apiWaitsForLock(): Promise<boolean> {
  const [row] = await db.prisma.$queryRaw<{ waiting: number }[]>`
    SELECT count(*)::int AS waiting
    FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%payers%'`
  return (row?.waiting ?? 0) > 0
}

beforeAll(async () => {
  ensureFreshBuild()
  await truncateAll(db.prisma)
  await createPayer(db.prisma)
}, 120_000)

afterEach(async () => {
  for (const release of locks.splice(0)) release()
  for (const socket of clients.splice(0)) socket.destroy()
  for (const api of apis.splice(0)) {
    if (api.child.exitCode === null && api.child.signalCode === null) api.child.kill('SIGKILL')
    await api.exited
  }
  for (const dir of workDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

afterAll(async () => {
  await db.close()
})

describe('apagado de la API compilada (SIGTERM)', () => {
  it('cierra en el acto la conexión keep-alive ociosa, responde la petición en curso con Connection: close y sale con 0 mucho antes del plazo', async () => {
    const api = await startApi({ SHUTDOWN_TIMEOUT_MS: '15000', OUTBOX_HANDLER_TIMEOUT_MS: '1000' })
    const idle = rawClient(api.port)
    idle.socket.write(get('/health'))
    await until(() => idle.received().includes('"process"'), 5_000, 'la sonda responde')
    expect(idle.received()).toMatch(/\r\nConnection: keep-alive\r\n/i)

    const lock = await lockPayers()
    const busy = rawClient(api.port)
    busy.socket.write(get('/api/v1/payers'))
    await until(apiWaitsForLock, 5_000, 'la lectura de pagadores espera el candado')

    const signaledAt = Date.now()
    api.child.kill('SIGTERM')
    const idleClosedAt = await waitFor(idle.closed, 2_000, 'se cierra la conexión ociosa')
    expect(idleClosedAt - signaledAt).toBeLessThan(1_000)

    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(api.child.exitCode).toBeNull()
    lock.release()
    await lock.done
    await waitFor(busy.closed, 5_000, 'la conexión de la petición en curso se cierra', () =>
      JSON.stringify(busy.received().slice(0, 300)),
    )
    expect(busy.received()).toMatch(/^HTTP\/1\.1 200 OK\r\n/)
    expect(busy.received()).toMatch(/\r\nConnection: close\r\n/i)
    expect(busy.received()).toContain('"slug":"sea"')

    const exit = await waitFor(api.exited, 10_000, 'el proceso sale', api.output)
    expect(exit.code, api.output()).toBe(0)
    expect(exit.at - signaledAt).toBeLessThan(5_000)
    expect(api.output()).toMatch(/Apagado por SIGTERM: .*SHUTDOWN_TIMEOUT_MS/)
    expect(api.output()).toMatch(/Apagado completo en \d+ ms/)
  })

  it('una petición que no termina: al vencer el plazo corta la conexión y sale con 1, con un log de error', async () => {
    const api = await startApi({ SHUTDOWN_TIMEOUT_MS: '3000', OUTBOX_HANDLER_TIMEOUT_MS: '1000' })
    await lockPayers()
    const busy = rawClient(api.port)
    busy.socket.write(get('/api/v1/payers'))
    await until(apiWaitsForLock, 5_000, 'la lectura de pagadores espera el candado')

    const signaledAt = Date.now()
    api.child.kill('SIGTERM')
    const exit = await waitFor(api.exited, 8_000, 'el proceso sale', api.output)
    expect(exit.code, api.output()).toBe(1)
    expect(exit.at - signaledAt).toBeGreaterThanOrEqual(2_900)
    expect(exit.at - signaledAt).toBeLessThan(4_500)
    await waitFor(busy.closed, 2_000, 'la conexión cortada se cierra')
    expect(busy.received()).toBe('')
    expect(api.output()).toContain(
      'El apagado no terminó: venció el plazo de 3000 ms (SHUTDOWN_TIMEOUT_MS). Se cortan 1 conexiones (1 con una petición sin responder) y el proceso sale con código 1',
    )
  })
})
