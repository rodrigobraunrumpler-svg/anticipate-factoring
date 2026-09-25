import { createHash } from 'node:crypto'
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3'
import { afterAll, describe, expect, it } from 'vitest'
import {
  buildContentDisposition,
  InvalidObjectKeyError,
  objectKeyProblem,
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

/** Nunca responde ni mira la señal: como el SDK mientras espera entre dos intentos. */
const ignoresAbort: Reply = () => new Promise(() => {})

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

  it('si una falla, espera las subidas en curso, borra todas las que mandó y relanza el error', async () => {
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
    // También la que falló: el proveedor pudo guardarla aunque la respuesta dijera otra cosa.
    expect(fake.names()).toEqual([
      `${PutObjectCommand.name}:k/a.xml`,
      `${PutObjectCommand.name}:k/a.pdf`,
      `${DeleteObjectCommand.name}:k/a.xml`,
      `${DeleteObjectCommand.name}:k/a.pdf`,
    ])
  })

  it('rechaza claves repetidas antes de subir nada: un objeto no puede tener dos contenidos', async () => {
    const fake = new FakeS3Client()

    await expect(
      adapterWith(fake).putAll([xml, pdf, { ...pdf, key: xml.key }]),
    ).rejects.toMatchObject({
      name: 'InvalidObjectKeyError',
      message: 'Clave de objeto inválida: está repetida en la misma subida.',
    })
    expect(fake.sent).toEqual([])
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

/** Lo que informa el validador por cada regla. */
const EMPTY = 'está vacía'
const LEADING_SLASH = 'empieza con "/"'
const EMPTY_SEGMENT = 'tiene un segmento vacío ("//" o "/" al final)'
const DOT_SEGMENT = 'tiene un segmento "." o ".."'
const CONTROL = 'tiene caracteres de control o surrogates UTF-16 sueltos'
const TOO_LONG = 'pasa de 1024 bytes en UTF-8'

/** Una clave inválida por regla, con el problema que informa el validador. */
const INVALID_KEYS: ReadonlyArray<readonly [label: string, key: string, problem: string]> = [
  ['vacía', '', EMPTY],
  ['que empieza con "/"', '/payers/p/a.pdf', LEADING_SLASH],
  ['que es solo "/"', '/', LEADING_SLASH],
  ['con "//"', 'payers//a.pdf', EMPTY_SEGMENT],
  ['que termina en "/"', 'payers/p/', EMPTY_SEGMENT],
  ['"."', '.', DOT_SEGMENT],
  ['".."', '..', DOT_SEGMENT],
  ['con un segmento "."', 'payers/./a.pdf', DOT_SEGMENT],
  ['con un segmento ".."', 'payers/../a.pdf', DOT_SEGMENT],
  ['que termina en "/.."', 'payers/..', DOT_SEGMENT],
  ['con un control C0', 'payers/a\u0000.pdf', CONTROL],
  ['con un salto de línea', 'payers/a\n.pdf', CONTROL],
  ['con DEL', 'payers/a\u007f.pdf', CONTROL],
  ['con un control C1', 'payers/a\u0085.pdf', CONTROL],
  ['con un surrogate alto suelto', 'payers/a\uD800.pdf', CONTROL],
  ['con un surrogate bajo suelto', 'payers/\uDC00a.pdf', CONTROL],
  ['de 1025 bytes', 'a'.repeat(1_025), TOO_LONG],
  ['de 1026 bytes en 513 caracteres', 'ñ'.repeat(513), TOO_LONG],
]

describe('objectKeyProblem', () => {
  it.each([
    'payers/p/a.pdf',
    'a',
    '...',
    'payers/.../a.pdf',
    '.oculto/a..b/c.',
    'payers/p/Factura 😀 (1)%2F?#.pdf',
    'x'.repeat(1_024),
    'ñ'.repeat(512),
  ])('acepta %j', (key) => {
    expect(objectKeyProblem(key)).toBeUndefined()
  })

  it.each(INVALID_KEYS)('rechaza una clave %s', (_label, key, problem) => {
    expect(objectKeyProblem(key)).toBe(problem)
  })

  it('rechaza lo que no es texto', () => {
    for (const key of [undefined, null, 42, {}]) {
      expect(objectKeyProblem(key as unknown as string)).toBe('no es texto')
    }
  })
})

describe('S3FileStorageAdapter: una clave inválida nunca llega al proveedor', () => {
  // Con una clave vacía el SDK arma la ruta del bucket: DELETE borraría el bucket, HEAD diría que
  // existe y un GET firmado listaría todas sus claves.
  const signer = new S3Client({
    endpoint: 'http://127.0.0.1:9',
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  })
  afterAll(() => signer.destroy())

  it.each(INVALID_KEYS)(
    'putAll rechaza una clave %s antes de subir nada, como promesa rechazada',
    async (_label, key, problem) => {
      const fake = new FakeS3Client()
      let result: Promise<unknown> | undefined
      expect(() => {
        result = adapterWith(fake).putAll([xml, { ...pdf, key }])
      }).not.toThrow()

      await expect(result).rejects.toThrow(new InvalidObjectKeyError(problem))
      await expect(result).rejects.toBeInstanceOf(InvalidObjectKeyError)
      expect(fake.sent).toEqual([])
    },
  )

  it.each(INVALID_KEYS)('exists rechaza una clave %s sin consultar', async (_label, key) => {
    const fake = new FakeS3Client()
    let result: Promise<unknown> | undefined
    expect(() => {
      result = adapterWith(fake).exists(key)
    }).not.toThrow()

    await expect(result).rejects.toBeInstanceOf(InvalidObjectKeyError)
    expect(fake.sent).toEqual([])
  })

  it.each(INVALID_KEYS)('downloadUrl rechaza una clave %s sin firmar', async (_label, key) => {
    const storage = new S3FileStorageAdapter(signer, { bucket: 'anticipate-local' })
    let result: Promise<unknown> | undefined
    expect(() => {
      result = storage.downloadUrl(key, 'a.pdf')
    }).not.toThrow()

    await expect(result).rejects.toBeInstanceOf(InvalidObjectKeyError)
  })

  it.each(INVALID_KEYS)(
    'deleteQuietly devuelve como no borrada una clave %s sin mandarla',
    async (_label, key) => {
      const fake = new FakeS3Client()

      await expect(adapterWith(fake).deleteQuietly([key])).resolves.toEqual([key])
      expect(fake.sent).toEqual([])
    },
  )

  it('deleteQuietly borra las válidas y devuelve las inválidas, en el orden de entrada', async () => {
    const fake = new FakeS3Client()

    await expect(
      adapterWith(fake).deleteQuietly(['k/a', '', 'k/b', '/k/c', 'k/a', '']),
    ).resolves.toEqual(['', '/k/c'])
    expect(fake.names()).toEqual([
      `${DeleteObjectCommand.name}:k/a`,
      `${DeleteObjectCommand.name}:k/b`,
    ])
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
    // Solo se borra la que se mandó: las que no empezaron nunca llegaron al proveedor.
    expect(fake.names()).toEqual([
      `${PutObjectCommand.name}:u/0.xml`,
      `${DeleteObjectCommand.name}:u/0.xml`,
    ])
  })

  it('una subida que esperaba cupo cuando otra falló ya no se manda', async () => {
    const rejected = new Error('subida rechazada')
    const fake = new FakeS3Client().on(PutObjectCommand.name, 'k/a.xml', () =>
      sleep(5).then(() => Promise.reject(rejected)),
    )
    const storage = adapterWith(fake, { maxConcurrentRequests: 1, maxConcurrentRequestsPerCall: 2 })

    await expect(storage.putAll([xml, pdf])).rejects.toBe(rejected)
    expect(fake.names()).toEqual([
      `${PutObjectCommand.name}:k/a.xml`,
      `${DeleteObjectCommand.name}:k/a.xml`,
    ])
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
  it('putAll corta con TimeoutError una subida que no termina y borra todas las que mandó', async () => {
    const fake = new FakeS3Client().on(PutObjectCommand.name, 'k/a.pdf', hangUntilAborted)

    const startedAt = Date.now()
    await expect(adapterWith(fake, { operationTimeoutMs: 50 }).putAll([xml, pdf])).rejects.toThrow(
      expect.objectContaining({
        name: 'TimeoutError',
        message: 'PutObject no terminó en 50 ms.',
      }),
    )
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(fake.names()).toEqual(
      expect.arrayContaining([
        `${DeleteObjectCommand.name}:k/a.xml`,
        `${DeleteObjectCommand.name}:k/a.pdf`,
      ]),
    )
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

  it('rechaza al vencer el plazo aunque el proveedor no atienda la cancelación, y libera el cupo', async () => {
    const fake = new FakeS3Client().on(HeadObjectCommand.name, 'k/cuelga.xml', ignoresAbort)
    const storage = adapterWith(fake, {
      maxConcurrentRequests: 1,
      maxConcurrentRequestsPerCall: 1,
      operationTimeoutMs: 50,
    })

    const startedAt = Date.now()
    // La segunda espera el único cupo: lo recibe apenas vence el plazo de la primera.
    const [hung, next] = await Promise.allSettled([
      storage.exists('k/cuelga.xml'),
      storage.exists('k/a.xml'),
    ])

    expect(hung).toMatchObject({
      status: 'rejected',
      reason: { name: 'TimeoutError', message: 'HeadObject no terminó en 50 ms.' },
    })
    expect(next).toEqual({ status: 'fulfilled', value: true })
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })

  it('putAll rechaza al vencer el plazo aunque el proveedor no atienda la cancelación, y borra esa clave', async () => {
    const fake = new FakeS3Client().on(PutObjectCommand.name, 'k/a.pdf', ignoresAbort)

    const startedAt = Date.now()
    await expect(adapterWith(fake, { operationTimeoutMs: 50 }).putAll([xml, pdf])).rejects.toThrow(
      expect.objectContaining({ name: 'TimeoutError', message: 'PutObject no terminó en 50 ms.' }),
    )
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(fake.names()).toEqual(
      expect.arrayContaining([
        `${DeleteObjectCommand.name}:k/a.xml`,
        `${DeleteObjectCommand.name}:k/a.pdf`,
      ]),
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
  /** Firma con un cliente real: firmar no contacta al proveedor, el endpoint puede no existir. */
  async function signedUrl(key: string, downloadName: string): Promise<URL> {
    const client = new S3Client({
      endpoint: 'http://127.0.0.1:9',
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    })
    try {
      const storage = new S3FileStorageAdapter(client, { bucket: 'anticipate-local' })
      return new URL(await storage.downloadUrl(key, downloadName))
    } finally {
      client.destroy()
    }
  }

  it('firma por 300 segundos con el nombre de descarga y sin contactar al proveedor', async () => {
    const url = await signedUrl('payers/p/a.pdf', 'ANT-2026-000001 F001-1.pdf')

    expect(url.pathname).toBe('/anticipate-local/payers/p/a.pdf')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300')
    expect(url.searchParams.get('response-content-disposition')).toBe(
      'attachment; filename="ANT-2026-000001 F001-1.pdf"',
    )
  })

  it('firma aunque el nombre traiga un surrogate UTF-16 suelto', async () => {
    const url = await signedUrl('payers/p/a.pdf', 'x\uD800.pdf')

    expect(url.searchParams.get('response-content-disposition')).toBe(
      'attachment; filename="x_.pdf"',
    )
  })

  it('nunca lanza de forma síncrona: cualquier falla llega como promesa rechazada', async () => {
    const storage = adapterWith(new FakeS3Client())
    // Un nombre que no es texto hace fallar el armado de la cabecera, antes de firmar: quien encadena
    // `.catch()` igual tiene que ver el error.
    let result: Promise<string> | undefined
    expect(() => {
      result = storage.downloadUrl('payers/p/a.pdf', undefined as unknown as string)
    }).not.toThrow()

    await expect(result).rejects.toBeInstanceOf(TypeError)
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

  it('cambia por "_" los surrogates UTF-16 sueltos en vez de lanzar URIError', () => {
    expect(buildContentDisposition('x\uD800.pdf')).toBe('attachment; filename="x_.pdf"')
    expect(buildContentDisposition('x\uDC00\uD83D.pdf')).toBe('attachment; filename="x__.pdf"')
    expect(buildContentDisposition('Fáctura \uDFFF.pdf')).toBe(
      `attachment; filename="Factura _.pdf"; filename*=UTF-8''F%C3%A1ctura%20_.pdf`,
    )
  })

  it('neutraliza también los controles C1 (U+0080 a U+009F)', () => {
    expect(buildContentDisposition('a\u0085b\u009f.pdf')).toBe('attachment; filename="a_b_.pdf"')
  })

  it('un carácter fuera del plano básico vale un "_" en la versión ASCII y va entero en filename*', () => {
    expect(buildContentDisposition('Factura 😀.pdf')).toBe(
      `attachment; filename="Factura _.pdf"; filename*=UTF-8''Factura%20%F0%9F%98%80.pdf`,
    )
    // El recorte cuenta caracteres, no unidades UTF-16: nunca parte un par de surrogates.
    expect(buildContentDisposition(`${'a'.repeat(149)}😀😀`)).toBe(
      `attachment; filename="${'a'.repeat(149)}_"; filename*=UTF-8''${'a'.repeat(149)}%F0%9F%98%80`,
    )
  })

  it('neutraliza los caracteres de formato y los separadores de línea y de párrafo', () => {
    // U+202E (RLO) invierte lo que sigue: 'factura\u202Efdp.exe' se ve como 'facturaexe.pdf'.
    expect(buildContentDisposition('factura\u202Efdp.exe')).toBe(
      'attachment; filename="factura_fdp.exe"',
    )
    expect(buildContentDisposition('a\u2028b\u2029.pdf')).toBe('attachment; filename="a_b_.pdf"')
    // Espacio de ancho cero, marca de izquierda a derecha y BOM, junto a una tilde que sí queda.
    expect(buildContentDisposition('Fáctura\u200B\u200E\uFEFF.pdf')).toBe(
      `attachment; filename="Factura___.pdf"; filename*=UTF-8''F%C3%A1ctura___.pdf`,
    )
  })

  it('usa "archivo" en la versión ASCII si sin tildes no queda nada', () => {
    expect(buildContentDisposition('́́')).toBe(
      `attachment; filename="archivo"; filename*=UTF-8''%CC%81%CC%81`,
    )
  })

  it('nunca lanza y siempre devuelve una cabecera segura, con cualquier secuencia UTF-16', () => {
    const random = seededRandom(0x5eed)
    const names = [
      '',
      '\uD800',
      '\uDBFF\uDBFF',
      '\uDC00',
      '\uDC00\uD800',
      '😀',
      `${'a'.repeat(149)}😀`,
      `${'a'.repeat(150)}\uD83D`,
      `${'a'.repeat(149)}\uD83D`,
      ' ́ ',
      '"\\/\u0000\u007f\u0085',
      '\u202E',
      'a\u2028\u2029',
      '\uFEFF\u200B\u2066',
      ...Array.from({ length: 3_000 }, () => randomUtf16(random)),
    ]

    const failures: string[] = []
    for (const name of names) {
      try {
        const header = buildContentDisposition(name)
        const encoded = /; filename\*=UTF-8''(.*)$/.exec(header)?.[1]
        // decodeURIComponent lanza si filename* no es UTF-8 válido.
        const decoded = encoded === undefined ? '' : decodeURIComponent(encoded)
        if (!SAFE_CONTENT_DISPOSITION.test(header) || UNSAFE_IN_FILE_NAME.test(decoded)) {
          failures.push(`${JSON.stringify(name)} → ${header}`)
        }
      } catch (error) {
        failures.push(`${JSON.stringify(name)} → ${String(error)}`)
      }
    }
    expect(failures).toEqual([])
  })
})

/**
 * `filename` no vacío en ASCII imprimible sin comillas ni barra invertida y, si va, `filename*` solo
 * con caracteres de RFC 5987 o escapes `%XX`: nada que corte la cabecera ni el parámetro.
 */
const SAFE_CONTENT_DISPOSITION =
  /^attachment; filename="[\x20\x21\x23-\x5b\x5d-\x7e]+"(?:; filename\*=UTF-8''(?:[A-Za-z0-9!\-._~]|%[0-9A-F]{2})+)?$/
const UNSAFE_IN_FILE_NAME = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}"\\/]/u

/** mulberry32: números pseudoaleatorios reproducibles entre 0 y 1. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** Unidades UTF-16 sueltas de rangos elegidos para que abunden los casos raros. */
const CODE_UNIT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x20, 0x7e], // ASCII imprimible
  [0x00, 0x1f], // controles C0
  [0x7f, 0x9f], // DEL y controles C1
  [0xa0, 0x17f], // latín con tildes
  [0x300, 0x36f], // marcas combinantes
  [0x2000, 0x206f], // puntuación general: formato (RLO, LRM, ancho cero) y separadores U+2028/9
  [0xd800, 0xdbff], // surrogates altos
  [0xdc00, 0xdfff], // surrogates bajos
  [0xe000, 0xffff], // resto del plano básico
]

function randomUtf16(random: () => number): string {
  const length = Math.floor(random() * 200)
  let text = ''
  for (let i = 0; i < length; i += 1) {
    const [from, to] = CODE_UNIT_RANGES[Math.floor(random() * CODE_UNIT_RANGES.length)] ?? [0, 0]
    text += String.fromCharCode(from + Math.floor(random() * (to - from + 1)))
  }
  return text
}
