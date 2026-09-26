import { createServer, type Server, type Socket } from 'node:net'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isDatabaseUnavailableError, type PrismaService } from '#/infrastructure/prisma/index.js'
import { testEnv } from '../support/config.js'
import { createTestPrisma, type TestDatabase, truncateAll } from '../support/db.js'
import { createPayer } from '../support/factories.js'

/**
 * Fija contra PostgreSQL real las formas de error que `isDatabaseUnavailableError` reconoce. Si una
 * versión nueva de Prisma, `@prisma/adapter-pg` o `pg` cambia cómo llega una base caída, falla aquí
 * y no en producción como un 500.
 */

const DATABASE_URL = testEnv().DATABASE_URL ?? ''
/** `DATABASE_URL` de los tests con otro puerto, otra contraseña u otra base. */
const urlWith = (parts: Partial<Pick<URL, 'port' | 'password' | 'pathname'>>): string =>
  Object.assign(new URL(DATABASE_URL), parts).toString()

const databases: TestDatabase[] = []
const servers: { server: Server; sockets: Set<Socket> }[] = []
const clients: pg.Client[] = []

/** Un `PrismaService` como el de la app, que se cierra al terminar el archivo. */
function database(env: Record<string, string> = {}): PrismaService {
  const created = createTestPrisma(env)
  databases.push(created)
  return created.prisma
}

/** Un servidor TCP local que hace `onConnection` con cada conexión: cortarla o no responder. */
async function tcpServer(onConnection: (socket: Socket) => void): Promise<number> {
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    onConnection(socket)
  })
  servers.push({ server, sockets })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('sin puerto')
  return address.port
}

/** Conexión aparte a `anticipate_test`, para bloquear tablas o terminar la conexión de Prisma. */
async function sideClient(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: DATABASE_URL })
  await client.connect()
  clients.push(client)
  return client
}

/** Espera a que la conexión `pid` esté ejecutando una consulta (o esperando un bloqueo). */
async function untilActive(side: pg.Client, pid: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const { rows } = await side.query<{ state: string | null }>(
      'SELECT state FROM pg_stat_activity WHERE pid = $1',
      [pid],
    )
    if (rows[0]?.state === 'active') return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`la conexión ${pid} nunca quedó activa`)
}

async function backendPid(prisma: PrismaService): Promise<number> {
  const [row] = await prisma.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
  if (row === undefined) throw new Error('sin pid')
  return row.pid
}

const failureOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error('se esperaba un error')
    },
    (error: unknown) => error,
  )

afterAll(async () => {
  for (const client of clients) await client.end().catch(() => undefined)
  for (const { close } of databases) await close().catch(() => undefined)
  for (const { server, sockets } of servers) {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
})

describe('isDatabaseUnavailableError contra fallas reales de la base', () => {
  it('base inalcanzable: query builder, SQL crudo y transacción', async () => {
    const closed = database({ DATABASE_URL: urlWith({ port: '1' }) })
    expect(isDatabaseUnavailableError(await failureOf(closed.payer.findMany()))).toBe(true)
    expect(isDatabaseUnavailableError(await failureOf(closed.$queryRaw`SELECT 1`))).toBe(true)
    const transaction = closed.$transaction(async (tx) => tx.payer.findMany())
    expect(isDatabaseUnavailableError(await failureOf(transaction))).toBe(true)
  })

  it('credenciales rechazadas y base inexistente', async () => {
    const auth = database({ DATABASE_URL: urlWith({ password: 'otra' }) })
    expect(isDatabaseUnavailableError(await failureOf(auth.payer.findMany()))).toBe(true)
    const missing = database({ DATABASE_URL: urlWith({ pathname: '/nope_test' }) })
    expect(isDatabaseUnavailableError(await failureOf(missing.payer.findMany()))).toBe(true)
    expect(isDatabaseUnavailableError(await failureOf(missing.$queryRaw`SELECT 1`))).toBe(true)
  })

  it('el servidor corta la conexión al conectar', async () => {
    const port = await tcpServer((socket) => socket.destroy())
    const reset = database({ DATABASE_URL: urlWith({ port: String(port) }) })
    expect(isDatabaseUnavailableError(await failureOf(reset.payer.findMany()))).toBe(true)
    expect(isDatabaseUnavailableError(await failureOf(reset.$queryRaw`SELECT 1`))).toBe(true)
    const transaction = reset.$transaction(async (tx) => tx.payer.findMany())
    expect(isDatabaseUnavailableError(await failureOf(transaction))).toBe(true)
  })

  it('el servidor no responde al conectar (DATABASE_CONNECTION_TIMEOUT_MS)', async () => {
    const port = await tcpServer(() => undefined)
    const silent = database({
      DATABASE_URL: urlWith({ port: String(port) }),
      DATABASE_CONNECTION_TIMEOUT_MS: '200',
    })
    expect(isDatabaseUnavailableError(await failureOf(silent.payer.findMany()))).toBe(true)
    const transaction = silent.$transaction(async (tx) => tx.payer.findMany())
    expect(isDatabaseUnavailableError(await failureOf(transaction))).toBe(true)
  })

  it('pool sin conexiones libres: consulta, SQL crudo y transacción que no empieza a tiempo', async () => {
    const small = database({
      DATABASE_POOL_MAX: '1',
      DATABASE_CONNECTION_TIMEOUT_MS: '200',
      DATABASE_TRANSACTION_MAX_WAIT_MS: '200',
    })
    let markHeld: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      markHeld = resolve
    })
    const holding = small.$transaction(async (tx) => {
      markHeld()
      await tx.$queryRaw`SELECT pg_sleep(1.5)::text`
    })
    await held
    try {
      expect(isDatabaseUnavailableError(await failureOf(small.payer.findMany()))).toBe(true)
      expect(isDatabaseUnavailableError(await failureOf(small.$queryRaw`SELECT 1`))).toBe(true)
      const waiting = small.$transaction(async (tx) => tx.payer.findMany())
      expect(isDatabaseUnavailableError(await failureOf(waiting))).toBe(true)
    } finally {
      await holding
    }
  })

  it('transacción vencida (DATABASE_TRANSACTION_TIMEOUT_MS)', async () => {
    const short = database({ DATABASE_TRANSACTION_TIMEOUT_MS: '1000' })
    const expired = short.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_sleep(1.2)::text`
      await tx.payer.findMany()
    })
    expect(isDatabaseUnavailableError(await failureOf(expired))).toBe(true)
  })

  it('statement_timeout y lock_timeout', async () => {
    const one = database({ DATABASE_POOL_MAX: '1' })
    const slow = one.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '100ms'`)
      await tx.$queryRaw`SELECT pg_sleep(1)::text`
    })
    expect(isDatabaseUnavailableError(await failureOf(slow))).toBe(true)

    const locker = await sideClient()
    await locker.query('BEGIN')
    await locker.query('LOCK TABLE payers IN ACCESS EXCLUSIVE MODE')
    try {
      const blocked = one.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '100ms'`)
        await tx.payer.findMany()
      })
      expect(isDatabaseUnavailableError(await failureOf(blocked))).toBe(true)
    } finally {
      await locker.query('ROLLBACK')
    }
  })

  it('la base termina la conexión durante una consulta (reinicio, failover)', async () => {
    const one = database({ DATABASE_POOL_MAX: '1' })
    const side = await sideClient()

    const rawPid = await backendPid(one)
    const raw = failureOf(one.$queryRaw`SELECT pg_sleep(5)::text`)
    await untilActive(side, rawPid)
    await side.query('SELECT pg_terminate_backend($1)', [rawPid])
    expect(isDatabaseUnavailableError(await raw)).toBe(true)

    const modelPid = await backendPid(one)
    await side.query('BEGIN')
    await side.query('LOCK TABLE payers IN ACCESS EXCLUSIVE MODE')
    const other = await sideClient()
    try {
      const model = failureOf(one.payer.findMany())
      await untilActive(other, modelPid)
      await other.query('SELECT pg_terminate_backend($1)', [modelPid])
      expect(isDatabaseUnavailableError(await model)).toBe(true)
    } finally {
      await side.query('ROLLBACK')
    }

    const inTransaction = one.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
      await other.query('SELECT pg_terminate_backend($1)', [row?.pid])
      await new Promise((resolve) => setTimeout(resolve, 50))
      await tx.payer.findMany()
    })
    expect(isDatabaseUnavailableError(await failureOf(inTransaction))).toBe(true)
  })

  it('el pool ya cerrado (la API se está apagando)', async () => {
    const ended = createTestPrisma()
    await ended.close()
    expect(isDatabaseUnavailableError(await failureOf(ended.prisma.payer.findMany()))).toBe(true)
  })
})

describe('isDatabaseUnavailableError no confunde un error de la consulta con una base caída', () => {
  const db = createTestPrisma()

  beforeAll(async () => {
    await truncateAll(db.prisma)
  })

  afterAll(async () => {
    await truncateAll(db.prisma)
    await db.close()
  })

  it('violación de unique, división por cero, valor inválido y error de sintaxis', async () => {
    await createPayer(db.prisma)
    const duplicate = await failureOf(createPayer(db.prisma, { ruc: '20100070970' }))
    const divisionByZero = await failureOf(db.prisma.$queryRaw`SELECT 1 / 0 AS x`)
    const invalidValue = await failureOf(db.prisma.$queryRaw`SELECT 'x'::int AS x`)
    const syntax = await failureOf(db.prisma.$queryRawUnsafe('SELECT FROM WHERE'))
    for (const error of [duplicate, divisionByZero, invalidValue, syntax]) {
      expect(isDatabaseUnavailableError(error)).toBe(false)
    }
  })
})
