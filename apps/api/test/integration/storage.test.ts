import { createHash, randomUUID } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import {
  S3_READINESS_TIMEOUT_MS,
  STORAGE_UNAVAILABLE_MESSAGE,
  storageTimeoutMessage,
} from '#/infrastructure/storage/s3/s3-readiness.indicator.js'
import { createTestApp } from '../support/app.js'
import { testConfig } from '../support/config.js'
import { createTestStorage, deletePrefix, listKeys, type TestStorage } from '../support/s3.js'

const { bucket } = testConfig().storage
const prefix = `tests/storage/${randomUUID()}/`
const key = (name: string) => `${prefix}${name}`
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const opened: TestStorage[] = []

function storageWith(options: Parameters<typeof createTestStorage>[0] = {}) {
  const testStorage = createTestStorage(options)
  opened.push(testStorage)
  return testStorage.storage
}

afterAll(async () => {
  await deletePrefix(prefix)
  for (const testStorage of opened) testStorage.destroy()
})

describe('S3FileStorageAdapter contra S3Mock', () => {
  it('sube todo, calcula el sha256 y los objetos quedan en el bucket', async () => {
    const storage = storageWith()
    const stored = await storage.putAll([
      { key: key('a.xml'), body: Buffer.from('<Invoice/>'), contentType: 'application/xml' },
      { key: key('a.pdf'), body: Buffer.from('%PDF-1.7'), contentType: 'application/pdf' },
    ])

    expect(stored).toEqual([
      { bucket, key: key('a.xml'), sizeBytes: 10, sha256: sha256('<Invoice/>') },
      { bucket, key: key('a.pdf'), sizeBytes: 8, sha256: sha256('%PDF-1.7') },
    ])
    expect(await storage.exists(key('a.xml'))).toBe(true)
    expect(await storage.exists(key('nunca-existio.xml'))).toBe(false)
  })

  it('putAll es todo o nada: si una subida falla, no queda ningún objeto', async () => {
    const storage = storageWith({ fault: { command: 'PutObjectCommand', keySuffix: 'falla.pdf' } })
    const batch = `${prefix}todo-o-nada/`

    await expect(
      storage.putAll([
        { key: `${batch}ok.xml`, body: Buffer.from('<Invoice/>'), contentType: 'application/xml' },
        { key: `${batch}falla.pdf`, body: Buffer.from('%PDF-1.7'), contentType: 'application/pdf' },
      ]),
    ).rejects.toThrow('PutObjectCommand rechazado a propósito')
    expect(await listKeys(batch)).toEqual([])
  })

  it('putAll rechaza si el bucket no existe', async () => {
    const storage = storageWith({ bucket: 'anticipate-no-existe' })

    await expect(
      storage.putAll([
        { key: key('x.xml'), body: Buffer.from('x'), contentType: 'application/xml' },
      ]),
    ).rejects.toMatchObject({ name: 'NoSuchBucket' })
  })

  it('deleteQuietly borra, tolera claves inexistentes y devuelve las que no pudo borrar', async () => {
    const batch = `${prefix}borrado/`
    await storageWith().putAll([
      { key: `${batch}uno.xml`, body: Buffer.from('1'), contentType: 'application/xml' },
      { key: `${batch}dos.xml`, body: Buffer.from('2'), contentType: 'application/xml' },
    ])
    const storage = storageWith({
      fault: { command: 'DeleteObjectCommand', keySuffix: 'dos.xml' },
    })

    await expect(
      storage.deleteQuietly([`${batch}uno.xml`, `${batch}dos.xml`, `${batch}nunca-existio.xml`]),
    ).resolves.toEqual([`${batch}dos.xml`])
    expect(await listKeys(batch)).toEqual([`${batch}dos.xml`])
  })

  it('firma enlaces de 5 minutos que descargan el archivo con el nombre pedido', async () => {
    const storage = storageWith()
    await storage.putAll([
      { key: key('c.pdf'), body: Buffer.from('%PDF-1.7'), contentType: 'application/pdf' },
    ])

    const url = await storage.downloadUrl(key('c.pdf'), 'ANT-2026-000001 Factúra F001-1.pdf')
    expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('300')

    const res = await fetch(url)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="ANT-2026-000001 Factura F001-1.pdf"; filename*=UTF-8''ANT-2026-000001%20Fact%C3%BAra%20F001-1.pdf`,
    )
    expect(await res.text()).toBe('%PDF-1.7')
  })
})

/** Servidor TCP que acepta conexiones y nunca responde: un almacenamiento colgado. */
async function startSilentServer(): Promise<{ url: string; stop: () => Promise<void> }> {
  const sockets = new Set<Socket>()
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('sin puerto')
  return {
    url: `http://127.0.0.1:${address.port}`,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}

describe('GET /health/readiness con el almacenamiento', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
  })

  async function start(env: Record<string, string> = {}): Promise<INestApplication> {
    const app = await createTestApp({ env })
    cleanups.push(() => app.close())
    return app
  }

  it('informa el almacenamiento arriba', async () => {
    const app = await start()
    const res = await request(app.getHttpServer()).get('/health/readiness').expect(200)
    expect(res.body.info.storage.status).toBe('up')
  })

  it('responde 503 si el bucket no existe, sin revelar el nombre ni el error del proveedor', async () => {
    const app = await start({ S3_BUCKET: 'anticipate-no-existe' })
    const res = await request(app.getHttpServer()).get('/health/readiness').expect(503)
    expect(res.body.error.storage).toMatchObject({
      status: 'down',
      message: STORAGE_UNAVAILABLE_MESSAGE,
    })
    expect(JSON.stringify(res.body)).not.toContain('anticipate-no-existe')
  })

  it('responde 503 a tiempo si el almacenamiento no contesta', async () => {
    const silent = await startSilentServer()
    cleanups.push(silent.stop)
    const app = await start({ S3_ENDPOINT: silent.url })

    const startedAt = Date.now()
    const res = await request(app.getHttpServer()).get('/health/readiness').expect(503)

    expect(res.body.error.storage).toMatchObject({
      status: 'down',
      message: storageTimeoutMessage(S3_READINESS_TIMEOUT_MS),
    })
    expect(Date.now() - startedAt).toBeLessThan(S3_READINESS_TIMEOUT_MS + 2_000)
  })
})
