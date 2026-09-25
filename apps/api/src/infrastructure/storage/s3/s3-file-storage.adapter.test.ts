import { createHash } from 'node:crypto'
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3'
import { describe, expect, it } from 'vitest'
import {
  buildContentDisposition,
  S3_REQUEST_LIMITS,
  S3FileStorageAdapter,
  type S3RequestLimits,
} from './s3-file-storage.adapter.js'

type SentCommand = { name: string; key: string | undefined; input: Record<string, unknown> }
type SendOptions = { abortSignal?: AbortSignal }
type Reply = (options: SendOptions) => Promise<unknown>

/**
 * Doble del cliente S3: registra cada comando, cuenta los que están en curso y responde con lo que
 * el test programe por comando y clave (o para cualquier clave del comando).
 */
class FakeS3Client {
  readonly sent: SentCommand[] = []
  private readonly replies = new Map<string, Reply>()
  private running = 0
  maxInFlight = 0

  on(commandName: string, key: string, reply: Reply): this {
    this.replies.set(`${commandName}:${key}`, reply)
    return this
  }

  onAny(commandName: string, reply: Reply): this {
    this.replies.set(`${commandName}:*`, reply)
    return this
  }

  send(
    command: { constructor: { name: string }; input: Record<string, unknown> },
    options: SendOptions = {},
  ) {
    const name = command.constructor.name
    const key = typeof command.input.Key === 'string' ? command.input.Key : undefined
    this.sent.push({ name, key, input: command.input })
    const reply = this.replies.get(`${name}:${key}`) ?? this.replies.get(`${name}:*`)
    this.running += 1
    this.maxInFlight = Math.max(this.maxInFlight, this.running)
    return (reply ? reply(options) : Promise.resolve({})).finally(() => {
      this.running -= 1
    })
  }

  names(): string[] {
    return this.sent.map((command) => `${command.name}:${command.key}`)
  }
}

function adapterWith(fake: FakeS3Client, limits?: Partial<S3RequestLimits>): S3FileStorageAdapter {
  return new S3FileStorageAdapter(fake as unknown as S3Client, {
    bucket: 'anticipate-local',
    limits: { ...S3_REQUEST_LIMITS, ...limits },
  })
}

function deferred() {
  let resolve: (value: unknown) => void = () => {}
  const promise = new Promise<unknown>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const after =
  (ms: number): Reply =>
  () =>
    sleep(ms).then(() => ({}))

/** Como el SDK: nunca responde y rechaza con AbortError cuando se cancela la señal. */
const hangUntilAborted: Reply = ({ abortSignal }) =>
  new Promise((_resolve, reject) => {
    abortSignal?.addEventListener(
      'abort',
      () => reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' })),
      { once: true },
    )
  })

const files = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => ({
    key: `${prefix}${index}.xml`,
    body: Buffer.from(`<Invoice n="${index}"/>`),
    contentType: 'application/xml',
  }))

function s3Error(name: string, httpStatusCode: number): S3ServiceException {
  return new S3ServiceException({ name, $fault: 'client', $metadata: { httpStatusCode } })
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const xml = { key: 'k/a.xml', body: Buffer.from('<Invoice/>'), contentType: 'application/xml' }
const pdf = { key: 'k/a.pdf', body: Buffer.from('%PDF-1.7'), contentType: 'application/pdf' }

describe('S3FileStorageAdapter.putAll', () => {
  it('sube todo y devuelve bucket, tamaño y sha256 en el orden de entrada', async () => {
    const fake = new FakeS3Client()
    const stored = await adapterWith(fake).putAll([xml, pdf])

    expect(stored).toEqual([
      { bucket: 'anticipate-local', key: 'k/a.xml', sizeBytes: 10, sha256: sha256('<Invoice/>') },
      { bucket: 'anticipate-local', key: 'k/a.pdf', sizeBytes: 8, sha256: sha256('%PDF-1.7') },
    ])
    expect(fake.sent[0]?.input).toMatchObject({
      Bucket: 'anticipate-local',
      Key: 'k/a.xml',
      ContentType: 'application/xml',
      ContentLength: 10,
    })
  })

  it('con una lista vacía no llama al proveedor', async () => {
    const fake = new FakeS3Client()
    await expect(adapterWith(fake).putAll([])).resolves.toEqual([])
    expect(fake.sent).toEqual([])
  })

  it('si una falla, espera las subidas en curso, borra las que llegaron y relanza el error', async () => {
    const slow = deferred()
    const rejected = new Error('subida rechazada')
    const fake = new FakeS3Client()
      .on(PutObjectCommand.name, 'k/a.xml', () => slow.promise)
      .on(PutObjectCommand.name, 'k/a.pdf', () => Promise.reject(rejected))
    let settled = false
    const result = adapterWith(fake)
      .putAll([xml, pdf])
      .finally(() => {
        settled = true
      })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(settled).toBe(false)
    expect(fake.names()).not.toContain(`${DeleteObjectCommand.name}:k/a.xml`)

    slow.resolve({})
    await expect(result).rejects.toBe(rejected)
    expect(fake.names()).toEqual([
      `${PutObjectCommand.name}:k/a.xml`,
      `${PutObjectCommand.name}:k/a.pdf`,
      `${DeleteObjectCommand.name}:k/a.xml`,
    ])
  })

  it('relanza el error de la subida aunque la limpieza también falle', async () => {
    const rejected = new Error('subida rechazada')
    const fake = new FakeS3Client()
      .on(PutObjectCommand.name, 'k/a.pdf', () => Promise.reject(rejected))
      .on(DeleteObjectCommand.name, 'k/a.xml', () => Promise.reject(s3Error('InternalError', 500)))

    await expect(adapterWith(fake).putAll([xml, pdf])).rejects.toBe(rejected)
  })
})

describe('S3FileStorageAdapter.deleteQuietly', () => {
  it('devuelve solo las claves que no se pudieron borrar, sin repetir, y nunca rechaza', async () => {
    const fake = new FakeS3Client().on(DeleteObjectCommand.name, 'k/b', () =>
      Promise.reject(s3Error('AccessDenied', 403)),
    )

    await expect(adapterWith(fake).deleteQuietly(['k/a', 'k/b', 'k/a', 'k/c'])).resolves.toEqual([
      'k/b',
    ])
    expect(fake.names()).toEqual([
      `${DeleteObjectCommand.name}:k/a`,
      `${DeleteObjectCommand.name}:k/b`,
      `${DeleteObjectCommand.name}:k/c`,
    ])
  })

  it('con una lista vacía no llama al proveedor', async () => {
    const fake = new FakeS3Client()
    await expect(adapterWith(fake).deleteQuietly([])).resolves.toEqual([])
    expect(fake.sent).toEqual([])
  })
})

describe('S3FileStorageAdapter.exists', () => {
  it('responde true si el objeto está y false si el proveedor dice 404', async () => {
    const fake = new FakeS3Client().on(HeadObjectCommand.name, 'k/falta', () =>
      Promise.reject(s3Error('NotFound', 404)),
    )
    const storage = adapterWith(fake)

    await expect(storage.exists('k/a.xml')).resolves.toBe(true)
    await expect(storage.exists('k/falta')).resolves.toBe(false)
  })

  it('relanza cualquier otro error: no confunde "sin permiso" con "no existe"', async () => {
    const denied = s3Error('AccessDenied', 403)
    const fake = new FakeS3Client().on(HeadObjectCommand.name, 'k/a.xml', () =>
      Promise.reject(denied),
    )
    await expect(adapterWith(fake).exists('k/a.xml')).rejects.toBe(denied)
  })
})

describe('S3FileStorageAdapter: peticiones en curso', () => {
  it('nunca tiene en curso más peticiones que el tope global, sumando todas las llamadas', async () => {
    const fake = new FakeS3Client()
      .onAny(PutObjectCommand.name, after(5))
      .onAny(DeleteObjectCommand.name, after(5))
    const storage = adapterWith(fake, { maxConcurrentRequests: 4, maxConcurrentRequestsPerCall: 3 })

    const [first, second, third, notDeleted] = await Promise.all([
      storage.putAll(files('u1/', 5)),
      storage.putAll(files('u2/', 5)),
      storage.putAll(files('u3/', 5)),
      storage.deleteQuietly(files('d/', 20).map(({ key }) => key)),
    ])

    expect(fake.maxInFlight).toBe(4)
    expect(fake.sent).toHaveLength(35)
    expect(first.map(({ key }) => key)).toEqual(files('u1/', 5).map(({ key }) => key))
    expect(second).toHaveLength(5)
    expect(third).toHaveLength(5)
    expect(notDeleted).toEqual([])
  })

  it('una misma llamada no pasa de su tope aunque haya cupos libres', async () => {
    const fake = new FakeS3Client().onAny(PutObjectCommand.name, after(5))
    const storage = adapterWith(fake, {
      maxConcurrentRequests: 10,
      maxConcurrentRequestsPerCall: 3,
    })

    await expect(storage.putAll(files('u/', 8))).resolves.toHaveLength(8)
    expect(fake.maxInFlight).toBe(3)
  })

  it('un lote grande de borrados deja cupos libres: una subida sale sin esperarlo', async () => {
    const gate = deferred()
    const fake = new FakeS3Client().onAny(DeleteObjectCommand.name, () => gate.promise)
    const storage = adapterWith(fake, { maxConcurrentRequests: 4, maxConcurrentRequestsPerCall: 2 })

    const purge = storage.deleteQuietly(files('d/', 10).map(({ key }) => key))
    await expect(storage.putAll([xml])).resolves.toHaveLength(1)
    expect(fake.sent.filter(({ name }) => name === DeleteObjectCommand.name)).toHaveLength(2)

    gate.resolve({})
    await expect(purge).resolves.toEqual([])
    expect(fake.sent.filter(({ name }) => name === DeleteObjectCommand.name)).toHaveLength(10)
  })

  it('devuelve los resultados en el orden de entrada aunque terminen en otro orden', async () => {
    const fake = new FakeS3Client()
      .on(PutObjectCommand.name, 'k/a.xml', after(20))
      .on(PutObjectCommand.name, 'k/a.pdf', after(0))

    const stored = await adapterWith(fake).putAll([xml, pdf])

    expect(stored.map(({ key }) => key)).toEqual(['k/a.xml', 'k/a.pdf'])
  })

  it('tras el primer fallo no empieza ninguna subida más', async () => {
    const rejected = new Error('subida rechazada')
    const fake = new FakeS3Client().on(PutObjectCommand.name, 'u/0.xml', () =>
      Promise.reject(rejected),
    )
    const storage = adapterWith(fake, { maxConcurrentRequestsPerCall: 1 })

    await expect(storage.putAll(files('u/', 3))).rejects.toBe(rejected)
    expect(fake.names()).toEqual([`${PutObjectCommand.name}:u/0.xml`])
  })

  it('una subida que esperaba cupo cuando otra falló ya no se manda', async () => {
    const rejected = new Error('subida rechazada')
    const fake = new FakeS3Client().on(PutObjectCommand.name, 'k/a.xml', () =>
      sleep(5).then(() => Promise.reject(rejected)),
    )
    const storage = adapterWith(fake, { maxConcurrentRequests: 1, maxConcurrentRequestsPerCall: 2 })

    await expect(storage.putAll([xml, pdf])).rejects.toBe(rejected)
    expect(fake.names()).toEqual([`${PutObjectCommand.name}:k/a.xml`])
  })

  it('rechaza límites que no son enteros positivos', () => {
    const fake = new FakeS3Client()
    for (const limits of [
      { maxConcurrentRequests: 0 },
      { maxConcurrentRequestsPerCall: 1.5 },
      { operationTimeoutMs: 0 },
      { operationTimeoutMs: 2 ** 31 },
      { operationTimeoutMs: Number.POSITIVE_INFINITY },
    ]) {
      expect(() => adapterWith(fake, limits)).toThrow(RangeError)
    }
  })
})

describe('S3FileStorageAdapter: plazo por operación', () => {
  it('putAll corta con TimeoutError una subida que no termina y borra las que llegaron', async () => {
    const fake = new FakeS3Client().on(PutObjectCommand.name, 'k/a.pdf', hangUntilAborted)

    const startedAt = Date.now()
    await expect(adapterWith(fake, { operationTimeoutMs: 50 }).putAll([xml, pdf])).rejects.toThrow(
      expect.objectContaining({
        name: 'TimeoutError',
        message: 'PutObject no terminó en 50 ms.',
      }),
    )
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(fake.names()).toContain(`${DeleteObjectCommand.name}:k/a.xml`)
  })

  it('deleteQuietly deja pendiente lo que no terminó y no manda más borrados tras un corte', async () => {
    const fake = new FakeS3Client().onAny(DeleteObjectCommand.name, hangUntilAborted)
    const storage = adapterWith(fake, {
      maxConcurrentRequests: 2,
      maxConcurrentRequestsPerCall: 2,
      operationTimeoutMs: 50,
    })
    const keys = files('d/', 6).map(({ key }) => key)

    const startedAt = Date.now()
    await expect(storage.deleteQuietly(keys)).resolves.toEqual(keys)
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(fake.sent).toHaveLength(2)
  })

  it('deleteQuietly sigue con el resto si un borrado falla sin corte por tiempo', async () => {
    const fake = new FakeS3Client().on(DeleteObjectCommand.name, 'd/0.xml', () =>
      Promise.reject(s3Error('AccessDenied', 403)),
    )
    const storage = adapterWith(fake, { maxConcurrentRequests: 1, maxConcurrentRequestsPerCall: 1 })
    const keys = files('d/', 4).map(({ key }) => key)

    await expect(storage.deleteQuietly(keys)).resolves.toEqual(['d/0.xml'])
    expect(fake.sent).toHaveLength(4)
  })

  it('exists corta con TimeoutError si el proveedor no responde', async () => {
    const fake = new FakeS3Client().onAny(HeadObjectCommand.name, hangUntilAborted)

    await expect(adapterWith(fake, { operationTimeoutMs: 50 }).exists('k/a.xml')).rejects.toThrow(
      expect.objectContaining({ name: 'TimeoutError', message: 'HeadObject no terminó en 50 ms.' }),
    )
  })

  it('el plazo corre desde que la petición obtiene su cupo, no mientras espera', async () => {
    const fake = new FakeS3Client().onAny(PutObjectCommand.name, after(50))
    const storage = adapterWith(fake, {
      maxConcurrentRequests: 1,
      maxConcurrentRequestsPerCall: 3,
      operationTimeoutMs: 120,
    })

    // La tercera espera unos 100 ms su cupo y tarda 50: pasa de 120 contando la espera.
    await expect(storage.putAll(files('u/', 3))).resolves.toHaveLength(3)
  })
})

describe('S3FileStorageAdapter.downloadUrl', () => {
  it('firma por 300 segundos con el nombre de descarga y sin contactar al proveedor', async () => {
    const client = new S3Client({
      endpoint: 'http://127.0.0.1:9',
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    })
    const storage = new S3FileStorageAdapter(client, { bucket: 'anticipate-local' })

    const url = new URL(await storage.downloadUrl('payers/p/a.pdf', 'ANT-2026-000001 F001-1.pdf'))
    client.destroy()

    expect(url.pathname).toBe('/anticipate-local/payers/p/a.pdf')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300')
    expect(url.searchParams.get('response-content-disposition')).toBe(
      'attachment; filename="ANT-2026-000001 F001-1.pdf"',
    )
  })
})

describe('buildContentDisposition', () => {
  it('deja tal cual un nombre ASCII', () => {
    expect(buildContentDisposition('ANT-2026-000123 F001-45.xml')).toBe(
      'attachment; filename="ANT-2026-000123 F001-45.xml"',
    )
  })

  it('agrega filename* en UTF-8 cuando hay tildes y una versión ASCII para el resto', () => {
    expect(buildContentDisposition('Factúra Ñandú (1).pdf')).toBe(
      `attachment; filename="Factura Nandu (1).pdf"; filename*=UTF-8''Fact%C3%BAra%20%C3%91and%C3%BA%20%281%29.pdf`,
    )
  })

  it('neutraliza comillas, barras y saltos de línea: nunca inyecta cabeceras ni rutas', () => {
    expect(buildContentDisposition('a"b\\c/d\r\nSet-Cookie: x.pdf')).toBe(
      'attachment; filename="a_b_c_d__Set-Cookie: x.pdf"',
    )
  })

  it('recorta nombres largos y usa "archivo" si no queda nada', () => {
    expect(buildContentDisposition(`${'a'.repeat(200)}.pdf`)).toBe(
      `attachment; filename="${'a'.repeat(150)}"`,
    )
    expect(buildContentDisposition('   ')).toBe('attachment; filename="archivo"')
  })
})
