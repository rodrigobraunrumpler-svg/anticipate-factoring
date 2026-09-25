import { describe, expect, it } from 'vitest'
import { testConfig } from '../../../test/support/config.js'
import { createDatabasePool, DATABASE_APPLICATION_NAME, PrismaService } from './prisma.service.js'

describe('createDatabasePool', () => {
  it('le pasa al pool solo la URL, el tamaño, los dos tiempos del cliente y el nombre de la app', async () => {
    const { database } = testConfig({
      DATABASE_POOL_MAX: '7',
      DATABASE_CONNECTION_TIMEOUT_MS: '1234',
      DATABASE_IDLE_TIMEOUT_MS: '4321',
    })
    const pool = createDatabasePool(database)
    try {
      expect(pool.options).toMatchObject({
        connectionString: database.url,
        max: 7,
        connectionTimeoutMillis: 1234,
        idleTimeoutMillis: 4321,
        application_name: DATABASE_APPLICATION_NAME,
      })
      for (const serverSide of [
        'statement_timeout',
        'lock_timeout',
        'idle_in_transaction_session_timeout',
        'options',
      ]) {
        expect(pool.options).not.toHaveProperty(serverSide)
      }
    } finally {
      await pool.end()
    }
  })
})

describe('PrismaService', () => {
  it('el adaptador usa el mismo pool (una sola copia de pg)', async () => {
    const prisma = new PrismaService(testConfig())
    const driver = await prisma.driverAdapter.connect()
    try {
      expect(driver.underlyingDriver()).toBe(prisma.databasePool)
    } finally {
      await driver.dispose()
      await prisma.onApplicationShutdown()
    }
  })

  it('no abre conexiones al construirse', async () => {
    const prisma = new PrismaService(
      testConfig({
        DATABASE_URL: 'postgresql://anticipate:anticipate@127.0.0.1:1/anticipate_test',
      }),
    )
    expect(prisma.databasePool.totalCount).toBe(0)
    await prisma.onApplicationShutdown()
  })

  it('toma los límites de las transacciones de la configuración', async () => {
    const prisma = new PrismaService(
      testConfig({
        DATABASE_TRANSACTION_TIMEOUT_MS: '12000',
        DATABASE_TRANSACTION_MAX_WAIT_MS: '3000',
      }),
    )
    expect(prisma.transactionOptions).toEqual({ timeout: 12_000, maxWait: 3_000 })
    await prisma.onApplicationShutdown()
  })

  it('al apagar cierra el pool, y un segundo apagado no falla', async () => {
    const prisma = new PrismaService(testConfig())
    await prisma.onApplicationShutdown()
    expect(prisma.databasePool.ended).toBe(true)
    await expect(prisma.onApplicationShutdown()).resolves.toBeUndefined()
  })
})
