import { createHash } from 'node:crypto'
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3'
import { describe, expect, it } from 'vitest'
import { buildContentDisposition, S3FileStorageAdapter } from './s3-file-storage.adapter.js'

type SentCommand = { name: string; key: string | undefined; input: Record<string, unknown> }
type Reply = () => Promise<unknown>

/** Doble del cliente S3: registra cada comando y responde con lo que el test programe por clave. */
class FakeS3Client {
  readonly sent: SentCommand[] = []
  private readonly replies = new Map<string, Reply>()

  on(commandName: string, key: string, reply: Reply): this {
    this.replies.set(`${commandName}:${key}`, reply)
    return this
  }

  send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
    const key = typeof command.input.Key === 'string' ? command.input.Key : undefined
    this.sent.push({ name: command.constructor.name, key, input: command.input })
    const reply = this.replies.get(`${command.constructor.name}:${key}`)
    return reply ? reply() : Promise.resolve({})
  }

  names(): string[] {
    return this.sent.map((command) => `${command.name}:${command.key}`)
  }
}

function adapterWith(fake: FakeS3Client): S3FileStorageAdapter {
  return new S3FileStorageAdapter(fake as unknown as S3Client, { bucket: 'anticipate-local' })
}

function deferred() {
  let resolve: (value: unknown) => void = () => {}
  const promise = new Promise<unknown>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

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
