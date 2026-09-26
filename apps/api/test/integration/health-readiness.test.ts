import type { NestExpressApplication } from '@nestjs/platform-express'
import request from 'supertest'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp } from '../support/app.js'
import { createTestPrisma, truncateAll } from '../support/db.js'

/** Puerto donde nada escucha: la conexión se rechaza al instante. */
const UNREACHABLE_DATABASE_URL = 'postgresql://anticipate:anticipate@127.0.0.1:1/anticipate_test'

let app: NestExpressApplication | undefined

// La readiness incluye el backlog del outbox: el `ok` no debe depender de lo que dejó otro archivo.
beforeAll(async () => {
  const db = createTestPrisma()
  await truncateAll(db.prisma)
  await db.close()
})

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('GET /health/readiness', () => {
  it('responde 200 con la base arriba, con el cuerpo de Terminus y sin sobre', async () => {
    app = await createTestApp()
    const response = await request(app.getHttpServer()).get('/health/readiness')
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ status: 'ok', info: { database: { status: 'up' } } })
    expect(response.body).not.toHaveProperty('success')
    expect(response.headers['x-correlation-id']).toBeTruthy()
  })

  it('responde 503 si la base no responde, sin revelar el host, y la liveness sigue en 200', async () => {
    app = await createTestApp({
      env: {
        DATABASE_URL: UNREACHABLE_DATABASE_URL,
        DATABASE_DIRECT_URL: UNREACHABLE_DATABASE_URL,
      },
    })
    const readiness = await request(app.getHttpServer()).get('/health/readiness')
    expect(readiness.status).toBe(503)
    expect(readiness.body).toMatchObject({
      status: 'error',
      error: { database: { status: 'down', message: 'La base de datos no respondió.' } },
    })
    expect(JSON.stringify(readiness.body)).not.toContain('127.0.0.1')

    const liveness = await request(app.getHttpServer()).get('/health')
    expect(liveness.status).toBe(200)
    expect(liveness.body).toMatchObject({ status: 'ok' })
  })

  it('no está bajo el prefijo api ni versionada', async () => {
    app = await createTestApp()
    expect((await request(app.getHttpServer()).get('/api/v1/health/readiness')).status).toBe(404)
  })
})
