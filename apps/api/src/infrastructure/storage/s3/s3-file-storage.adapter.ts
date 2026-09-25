import { createHash } from 'node:crypto'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { Logger } from '@nestjs/common'
import {
  DOWNLOAD_URL_TTL_SECONDS,
  type FileStoragePort,
  type PutFileInput,
  type StoredObject,
} from '#/common/storage/index.js'

export type S3FileStorageOptions = { readonly bucket: string }

const MAX_DOWNLOAD_NAME_LENGTH = 150
const FALLBACK_DOWNLOAD_NAME = 'archivo'

/** `FileStoragePort` sobre la API de S3 (R2 en staging y producción, S3Mock en local). */
export class S3FileStorageAdapter implements FileStoragePort {
  readonly bucket: string
  private readonly logger = new Logger(S3FileStorageAdapter.name)

  constructor(
    private readonly client: S3Client,
    options: S3FileStorageOptions,
  ) {
    this.bucket = options.bucket
  }

  async putAll(inputs: readonly PutFileInput[]): Promise<StoredObject[]> {
    // allSettled y no all: cuando se decide qué borrar, ninguna subida puede seguir en curso, o
    // un objeto llegaría después de la limpieza y quedaría sin fila que lo encuentre.
    const results = await Promise.allSettled(inputs.map((input) => this.put(input)))
    const stored: StoredObject[] = []
    const failures: unknown[] = []
    for (const result of results) {
      if (result.status === 'fulfilled') stored.push(result.value)
      else failures.push(result.reason)
    }
    if (failures.length === 0) return stored

    const notDeleted = await this.deleteQuietly(stored.map((object) => object.key))
    this.logger.warn(
      {
        failed: failures.length,
        uploaded: stored.length,
        notDeleted: notDeleted.length,
        error: describeError(failures[0]),
      },
      'Falló una subida; se intentó borrar las que sí llegaron.',
    )
    throw failures[0]
  }

  async deleteQuietly(keys: readonly string[]): Promise<string[]> {
    const outcomes = await Promise.all([...new Set(keys)].map((key) => this.deleteOne(key)))
    return outcomes.filter((key): key is string => key !== null)
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      return true
    } catch (error) {
      if (httpStatusOf(error) === 404) return false
      throw error
    }
  }

  downloadUrl(key: string, downloadName: string): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: buildContentDisposition(downloadName),
      }),
      { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
    )
  }

  private async put(input: PutFileInput): Promise<StoredObject> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        ContentLength: input.body.byteLength,
      }),
    )
    return {
      bucket: this.bucket,
      key: input.key,
      sizeBytes: input.body.byteLength,
      sha256: createHash('sha256').update(input.body).digest('hex'),
    }
  }

  /** Borra una clave; devuelve la clave si no se pudo borrar y `null` si quedó borrada. */
  private async deleteOne(key: string): Promise<string | null> {
    try {
      // DeleteObject unitario (sin cuerpo ni checksum) en vez de DeleteObjects, que exige una suma
      // de verificación que R2 no documenta con el SDK actual.
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
      return null
    } catch (error) {
      this.logger.warn(
        { key, error: describeError(error) },
        'No se pudo borrar un archivo del almacenamiento; queda pendiente.',
      )
      return key
    }
  }
}

/**
 * `Content-Disposition` de descarga (RFC 6266): `filename` en ASCII para cualquier navegador y
 * `filename*` en UTF-8 cuando el nombre tiene tildes. Quita comillas, barras y caracteres de
 * control, así que un nombre nunca inyecta otra cabecera ni una ruta.
 */
export function buildContentDisposition(downloadName: string): string {
  const name = sanitizeDownloadName(downloadName)
  const ascii = name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\x20-\x7e]/g, '_')
  if (ascii === name) return `attachment; filename="${ascii}"`
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(name)}`
}

function sanitizeDownloadName(downloadName: string): string {
  const chars = [...downloadName.normalize('NFC')].map((char) => {
    const code = char.codePointAt(0) ?? 0
    const unsafe = code < 0x20 || code === 0x7f || char === '"' || char === '\\' || char === '/'
    return unsafe ? '_' : char
  })
  const name = chars.slice(0, MAX_DOWNLOAD_NAME_LENGTH).join('').trim()
  return name === '' ? FALLBACK_DOWNLOAD_NAME : name
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

function httpStatusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('$metadata' in error)) return undefined
  return (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
}

/** Nombre y estado HTTP del error, sin mensajes que puedan traer hosts o credenciales. */
function describeError(error: unknown): { name: string; httpStatus: number | null } {
  return {
    name: error instanceof Error ? error.name : typeof error,
    httpStatus: httpStatusOf(error) ?? null,
  }
}
