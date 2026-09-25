import type { IncomingMessage, ServerResponse } from 'node:http'
import { HealthIndicatorService } from '@nestjs/terminus'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  replyDeleted,
  replyEmptyList,
  replySlowDown,
  replyStored,
  type S3StubHandler,
  startS3StubServer,
  trustStubCertificate,
} from '../../../../test/support/s3-stub-server.js'
import { createS3Client, type S3ClientTuning } from './s3-client.factory.js'
import { S3FileStorageAdapter, type S3RequestLimits } from './s3-file-storage.adapter.js'
import { S3ReadinessIndicator, storageTimeoutMessage } from './s3-readiness.indicator.js'

/**
 * El adaptador con el SDK real contra un servidor local: lo que un doble del cliente no muestra
 * (el pool de sockets del SDK, sus topes y cómo lee las respuestas).
 */

const credentials = {
  region: 'us-east-1',
  forcePathStyle: true,
  accessKeyId: 'a',
  secretAccessKey: 'b',
}
const bucket = 'stub'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function startStorage(
  handler: S3StubHandler,
  options: { tls?: boolean; tuning: S3ClientTuning; limits: S3RequestLimits },
) {
  const stub = await startS3StubServer(handler, { tls: options.tls ?? false })
  cleanups.push(stub.stop)
  const client = createS3Client({ ...credentials, endpoint: stub.url }, options.tuning)
  cleanups.push(() => client.destroy())
  const storage = new S3FileStorageAdapter(client, { bucket, limits: options.limits })
  return { stub, client, storage }
}

/** Responde cuando terminó de llegar el cuerpo de la petición. */
const afterBody =
  (reply: (req: IncomingMessage, res: ServerResponse) => void): S3StubHandler =>
  (req, res) => {
    req.resume()
    req.on('end', () => reply(req, res))
  }

const files = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => ({
    key: `${prefix}${index}.xml`,
    body: Buffer.from(`<Invoice n="${index}"/>`),
    contentType: 'application/xml',
  }))

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Clave del objeto en una ruta con estilo de ruta (`/<bucket>/<clave>`). */
const keyOf = (req: IncomingMessage) =>
  decodeURIComponent(new URL(req.url ?? '/', 'http://stub').pathname.slice(`/${bucket}/`.length))

describe('sobre HTTPS, con más subidas en curso que sockets en el pool', () => {
  let restoreCertificates: () => void = () => {}
  beforeAll(() => {
    restoreCertificates = trustStubCertificate()
  })
  afterAll(() => restoreCertificates())

  it('ninguna subida vence esperando socket y la readiness, que comparte el cliente, sigue arriba', async () => {
    // El SDK cuenta la espera de socket contra el tope de conexión (200 ms) y cada subida tarda
    // 300 ms: sin el tope del adaptador, las que no entran en los 3 sockets fallarían.
    const { stub, client, storage } = await startStorage(
      afterBody((req, res) => {
        if (req.method === 'PUT') setTimeout(() => replyStored(res), 300)
        else replyEmptyList(res)
      }),
      {
        tls: true,
        tuning: {
          connectionTimeoutMs: 200,
          requestTimeoutMs: 5_000,
          maxAttempts: 1,
          maxSockets: 3,
        },
        limits: {
          maxConcurrentRequests: 2,
          maxConcurrentRequestsPerCall: 2,
          operationTimeoutMs: 5_000,
        },
      },
    )
    const readiness = new S3ReadinessIndicator(client, new HealthIndicatorService(), {
      bucket,
      timeoutMs: 250,
      cacheTtlMs: 0,
    })

    const uploads = Promise.allSettled([
      storage.putAll(files('a/', 3)),
      storage.putAll(files('b/', 3)),
    ])
    await sleep(50)
    const whileBusy = await readiness.check('storage')
    const [first, second] = await uploads

    expect(whileBusy.storage).toMatchObject({ status: 'up' })
    expect(first).toMatchObject({
      status: 'fulfilled',
      value: [{ key: 'a/0.xml' }, { key: 'a/1.xml' }, { key: 'a/2.xml' }],
    })
    expect(second).toMatchObject({
      status: 'fulfilled',
      value: [{ key: 'b/0.xml' }, { key: 'b/1.xml' }, { key: 'b/2.xml' }],
    })
    expect(stub.maxInFlight('PUT')).toBe(2)
  })
})

describe('ante un proveedor que deja la respuesta a medias', () => {
  const tuning: S3ClientTuning = {
    connectionTimeoutMs: 1_000,
    requestTimeoutMs: 10_000,
    maxAttempts: 1,
    maxSockets: 50,
  }
  const limits: S3RequestLimits = {
    maxConcurrentRequests: 4,
    maxConcurrentRequestsPerCall: 4,
    operationTimeoutMs: 300,
  }

  /** Manda las cabeceras y el comienzo del cuerpo y no termina nunca: el SDK queda leyendo. */
  const headersThenStall = afterBody((req, res) => {
    res.writeHead(req.method === 'PUT' ? 200 : 503, {
      'Content-Type': 'application/xml',
      'Content-Length': '300',
    })
    res.write('<Error>')
  })

  it('deleteQuietly devuelve la clave como pendiente al vencer el plazo', async () => {
    const { storage } = await startStorage(headersThenStall, { tuning, limits })

    const startedAt = Date.now()
    await expect(storage.deleteQuietly(['k/a.xml'])).resolves.toEqual(['k/a.xml'])
    expect(Date.now() - startedAt).toBeLessThan(2_000)
  })

  it('putAll rechaza con TimeoutError al vencer el plazo', async () => {
    const { storage } = await startStorage(headersThenStall, { tuning, limits })

    const startedAt = Date.now()
    await expect(storage.putAll(files('u/', 1))).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(Date.now() - startedAt).toBeLessThan(2_000)
  })

  it('putAll borra también la subida que el proveedor guardó pero nunca confirmó', async () => {
    const objects = new Set<string>()
    const { storage } = await startStorage(
      afterBody((req, res) => {
        if (req.method === 'PUT') {
          objects.add(keyOf(req))
          // Guarda y no contesta: el cliente no sabe si llegó.
          if (!keyOf(req).endsWith('cuelga.xml')) replyStored(res)
        } else if (req.method === 'DELETE') {
          objects.delete(keyOf(req))
          replyDeleted(res)
        } else replyStored(res)
      }),
      { tuning, limits },
    )

    await expect(
      storage.putAll([
        ...files('u/', 2),
        { key: 'u/cuelga.xml', body: Buffer.from('<Invoice/>'), contentType: 'application/xml' },
      ]),
    ).rejects.toMatchObject({ name: 'TimeoutError' })
    expect([...objects]).toEqual([])
  })

  it('exists rechaza con TimeoutError al vencer el plazo aunque el SDK espere más', async () => {
    const { storage } = await startStorage(() => {}, { tuning, limits })

    const startedAt = Date.now()
    await expect(storage.exists('k/a.xml')).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(Date.now() - startedAt).toBeLessThan(2_000)
  })
})

describe('ante un proveedor que pide esperar antes de reintentar (503 SlowDown con Retry-After)', () => {
  // Con Retry-After el SDK espera 2 s antes del segundo intento y no mira la señal mientras tanto.
  const retryAfterSeconds = 2
  const tuning: S3ClientTuning = {
    connectionTimeoutMs: 1_000,
    requestTimeoutMs: 10_000,
    maxAttempts: 3,
    maxSockets: 50,
  }
  const limits: S3RequestLimits = {
    maxConcurrentRequests: 1,
    maxConcurrentRequestsPerCall: 1,
    operationTimeoutMs: 300,
  }

  it('la operación rechaza al vencer su plazo, libera el cupo y el SDK no manda otro intento', async () => {
    const { stub, storage } = await startStorage(
      afterBody((req, res) => {
        if (req.method === 'PUT') replySlowDown(res, retryAfterSeconds)
        else if (req.method === 'DELETE') replyDeleted(res)
        else replyStored(res)
      }),
      { tuning, limits },
    )

    const startedAt = Date.now()
    const upload = storage.putAll(files('u/', 1))
    // Espera el único cupo, que tiene la subida.
    const check = storage.exists('k/a.xml')

    await expect(upload).rejects.toMatchObject({
      name: 'TimeoutError',
      message: 'PutObject no terminó en 300 ms.',
    })
    await expect(check).resolves.toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(limits.operationTimeoutMs + 700)

    // Pasada la espera del SDK, el segundo intento no sale: la señal ya estaba cancelada.
    await sleep(retryAfterSeconds * 1_000 + 300)
    expect(stub.requests('PUT')).toBe(1)
    expect(stub.requests('DELETE')).toBe(1)
  })

  it('la readiness baja a tiempo y con el mensaje fijo aunque el SDK esté esperando', async () => {
    const { client } = await startStorage(
      afterBody((_req, res) => replySlowDown(res, retryAfterSeconds)),
      { tuning, limits },
    )
    const readiness = new S3ReadinessIndicator(client, new HealthIndicatorService(), {
      bucket,
      timeoutMs: 250,
      cacheTtlMs: 0,
    })

    const startedAt = Date.now()
    const result = await readiness.check('storage')

    expect(result.storage).toMatchObject({ status: 'down', message: storageTimeoutMessage(250) })
    expect(Date.now() - startedAt).toBeLessThan(250 + 500)
  })
})

describe('con claves inválidas', () => {
  const tuning: S3ClientTuning = {
    connectionTimeoutMs: 1_000,
    requestTimeoutMs: 5_000,
    maxAttempts: 1,
    maxSockets: 50,
  }
  const limits: S3RequestLimits = {
    maxConcurrentRequests: 4,
    maxConcurrentRequestsPerCall: 4,
    operationTimeoutMs: 2_000,
  }
  /** Una por regla del validador. */
  const invalidKeys = [
    '',
    '/',
    '/k/a.xml',
    'k//a.xml',
    'k/',
    '.',
    '..',
    'k/../a.xml',
    'k/a\u0000.xml',
    'k/a\uD800.xml',
    'a'.repeat(1_025),
  ]

  it('ninguna petición llega al proveedor: ni subida, ni consulta, ni borrado', async () => {
    const { stub, storage } = await startStorage(
      afterBody((req, res) => (req.method === 'DELETE' ? replyDeleted(res) : replyStored(res))),
      { tuning, limits },
    )

    for (const key of invalidKeys) {
      const body = Buffer.from('<Invoice/>')
      await expect(
        storage.putAll([{ key, body, contentType: 'application/xml' }]),
      ).rejects.toMatchObject({ name: 'InvalidObjectKeyError' })
      await expect(storage.exists(key)).rejects.toMatchObject({ name: 'InvalidObjectKeyError' })
      await expect(storage.downloadUrl(key, 'a.pdf')).rejects.toMatchObject({
        name: 'InvalidObjectKeyError',
      })
      await expect(storage.deleteQuietly([key])).resolves.toEqual([key])
    }
    expect(stub.requests()).toBe(0)

    // Una clave válida sí llega: el cero de arriba no es un servidor inalcanzable.
    await expect(storage.exists('k/a.xml')).resolves.toBe(true)
    expect(stub.requests()).toBe(1)
  })
})
