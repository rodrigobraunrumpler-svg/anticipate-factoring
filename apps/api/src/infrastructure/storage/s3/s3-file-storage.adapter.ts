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
import { ConcurrencyLimiter, forEachConcurrently } from './concurrency.js'
import { S3_CLIENT_TUNING } from './s3-client.factory.js'

/** Cuánto le pide el adaptador al proveedor a la vez y cuánto espera cada operación. */
export type S3RequestLimits = {
  /**
   * Peticiones en curso a la vez, sumando todas las llamadas de este adaptador. Queda por debajo de
   * `S3ClientTuning.maxSockets`: ninguna petición espera socket en el pool, donde esa espera gasta
   * el tope de conexión, y la readiness, que comparte el cliente, siempre encuentra uno libre.
   */
  readonly maxConcurrentRequests: number
  /**
   * Peticiones en curso de una misma llamada a `putAll` o `deleteQuietly`: una llamada grande, como
   * un lote del borrado diferido, nunca toma todos los cupos y deja lugar a las subidas.
   */
  readonly maxConcurrentRequestsPerCall: number
  /**
   * Plazo de una operación desde que obtiene su cupo: todos los intentos, las esperas entre ellos y
   * la lectura de la respuesta. Corta lo que el SDK deja colgado, como una respuesta que manda las
   * cabeceras y no termina el cuerpo.
   */
  readonly operationTimeoutMs: number
}

/** Margen del plazo por operación sobre los intentos del SDK: las esperas entre reintentos. */
const RETRY_BACKOFF_MARGIN_MS = 10_000

/**
 * 32 peticiones en curso contra 50 sockets; 16 por llamada, así un envío de 20 archivos sube casi
 * todo en paralelo y un lote de borrados deja la mitad de los cupos libres. El plazo por operación
 * (100 s) supera los 3 intentos de 30 s del cliente: solo actúa si el SDK no corta por su cuenta.
 */
export const S3_REQUEST_LIMITS: S3RequestLimits = Object.freeze({
  maxConcurrentRequests: 32,
  maxConcurrentRequestsPerCall: 16,
  operationTimeoutMs:
    S3_CLIENT_TUNING.maxAttempts * S3_CLIENT_TUNING.requestTimeoutMs + RETRY_BACKOFF_MARGIN_MS,
})

export type S3FileStorageOptions = {
  readonly bucket: string
  /** Por defecto, `S3_REQUEST_LIMITS`. */
  readonly limits?: S3RequestLimits
}

/** Una operación que no terminó en su plazo. Mismo `name` que los cortes por tiempo del SDK. */
export class StorageOperationTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number, options?: ErrorOptions) {
    super(`${operation} no terminó en ${timeoutMs} ms.`, options)
    this.name = 'TimeoutError'
  }
}

const MAX_DOWNLOAD_NAME_LENGTH = 150
const FALLBACK_DOWNLOAD_NAME = 'archivo'

/** La petición no se mandó: cuando obtuvo su cupo ya no hacía falta. */
const SKIPPED: unique symbol = Symbol('SKIPPED')

type RequestControl = {
  /** Se consulta al obtener el cupo: `false` descarta la petición sin mandarla. */
  readonly wanted?: () => boolean
  /** Recibe el error final, ya con el corte por plazo traducido, antes de liberar el cupo. */
  readonly onFailure?: (error: unknown) => void
}

/** `FileStoragePort` sobre la API de S3 (R2 en staging y producción, S3Mock en local). */
export class S3FileStorageAdapter implements FileStoragePort {
  readonly bucket: string
  private readonly logger = new Logger(S3FileStorageAdapter.name)
  private readonly limits: S3RequestLimits
  /** Cupos de peticiones en curso, compartidos por todas las llamadas de este adaptador. */
  private readonly requests: ConcurrencyLimiter

  constructor(
    private readonly client: S3Client,
    options: S3FileStorageOptions,
  ) {
    this.bucket = options.bucket
    this.limits = checkedLimits(options.limits ?? S3_REQUEST_LIMITS)
    this.requests = new ConcurrencyLimiter(this.limits.maxConcurrentRequests)
  }

  async putAll(inputs: readonly PutFileInput[]): Promise<StoredObject[]> {
    const stored: Array<StoredObject | undefined> = inputs.map(() => undefined)
    let firstFailure: { readonly error: unknown } | undefined
    let failed = 0
    // Todas las subidas terminan antes de decidir qué borrar: un objeto que llegara después de la
    // limpieza quedaría sin fila que lo encuentre. Tras el primer fallo no empieza ninguna más.
    await forEachConcurrently(
      inputs,
      this.limits.maxConcurrentRequestsPerCall,
      async (input, index) => {
        try {
          const result = await this.request(
            'PutObject',
            (abortSignal) => this.put(input, abortSignal),
            {
              wanted: () => firstFailure === undefined,
              // Antes de liberar el cupo: la subida que lo recibe ya no se manda.
              onFailure: (error) => {
                firstFailure ??= { error }
              },
            },
          )
          if (result !== SKIPPED) stored[index] = result
        } catch (error) {
          failed += 1
          firstFailure ??= { error }
        }
      },
    )
    const uploaded = stored.filter((object): object is StoredObject => object !== undefined)
    if (firstFailure === undefined) return uploaded

    const notDeleted = await this.deleteQuietly(uploaded.map((object) => object.key))
    this.logger.warn(
      {
        failed,
        uploaded: uploaded.length,
        notStarted: inputs.length - uploaded.length - failed,
        notDeleted: notDeleted.length,
        error: describeError(firstFailure.error),
      },
      'Falló una subida; se intentó borrar las que sí llegaron.',
    )
    throw firstFailure.error
  }

  async deleteQuietly(keys: readonly string[]): Promise<string[]> {
    const unique = [...new Set(keys)]
    const notDeleted = new Set<string>()
    // Si el proveedor deja de responder, cada borrado esperaría su plazo entero: no se mandan más y
    // lo que falta queda pendiente para la próxima pasada.
    let unresponsive = false
    let skipped = 0
    await forEachConcurrently(unique, this.limits.maxConcurrentRequestsPerCall, async (key) => {
      try {
        const result = await this.request(
          'DeleteObject',
          // DeleteObject unitario (sin cuerpo ni checksum) en vez de DeleteObjects, que exige una
          // suma de verificación que R2 no documenta con el SDK actual.
          (abortSignal) =>
            this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }), {
              abortSignal,
            }),
          {
            wanted: () => !unresponsive,
            onFailure: (error) => {
              if (isTimeout(error)) unresponsive = true
            },
          },
        )
        if (result === SKIPPED) {
          skipped += 1
          notDeleted.add(key)
        }
      } catch (error) {
        notDeleted.add(key)
        this.logger.warn(
          { key, error: describeError(error) },
          'No se pudo borrar un archivo del almacenamiento; queda pendiente.',
        )
      }
    })
    if (skipped > 0) {
      this.logger.warn(
        { skipped },
        'El almacenamiento dejó de responder; los borrados que faltaban quedan pendientes.',
      )
    }
    return unique.filter((key) => notDeleted.has(key))
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.request('HeadObject', (abortSignal) =>
        this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }), {
          abortSignal,
        }),
      )
      return true
    } catch (error) {
      if (httpStatusOf(error) === 404) return false
      throw error
    }
  }

  /**
   * `async` a propósito: cualquier falla, también al armar la cabecera antes de firmar, llega como
   * promesa rechazada y nunca como excepción síncrona que un `.catch()` encadenado no ve.
   */
  async downloadUrl(key: string, downloadName: string): Promise<string> {
    return await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: buildContentDisposition(downloadName),
      }),
      { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
    )
  }

  /**
   * Una petición al proveedor: espera un cupo del tope global y la corta si no termina en
   * `operationTimeoutMs`, contado desde que obtuvo el cupo. Si al obtenerlo `wanted` dice que ya no
   * hace falta, no la manda y resuelve `SKIPPED`. `onFailure` corre antes de liberar el cupo: la
   * petición que lo recibe ya ve el fallo en su `wanted`.
   */
  private request<T>(
    operation: string,
    send: (abortSignal: AbortSignal) => Promise<T>,
    control: RequestControl = {},
  ): Promise<T | typeof SKIPPED> {
    return this.requests.run(async () => {
      if (control.wanted?.() === false) return SKIPPED
      const { operationTimeoutMs } = this.limits
      // Un temporizador propio y no AbortSignal.timeout: se limpia al terminar en vez de quedar
      // pendiente hasta vencer o hasta que el recolector libere la señal.
      const deadline = new AbortController()
      const timer = setTimeout(() => deadline.abort(), operationTimeoutMs)
      try {
        return await send(deadline.signal)
      } catch (sendError) {
        const error = deadline.signal.aborted
          ? new StorageOperationTimeoutError(operation, operationTimeoutMs, { cause: sendError })
          : sendError
        control.onFailure?.(error)
        throw error
      } finally {
        clearTimeout(timer)
      }
    })
  }

  private async put(input: PutFileInput, abortSignal: AbortSignal): Promise<StoredObject> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        ContentLength: input.body.byteLength,
      }),
      { abortSignal },
    )
    return {
      bucket: this.bucket,
      key: input.key,
      sizeBytes: input.body.byteLength,
      sha256: createHash('sha256').update(input.body).digest('hex'),
    }
  }
}

/** Mayor demora que acepta `setTimeout`; con más, Node dispara el temporizador enseguida. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

function checkedLimits(limits: S3RequestLimits): S3RequestLimits {
  const { maxConcurrentRequests, maxConcurrentRequestsPerCall, operationTimeoutMs } = limits
  const isPositiveInteger = (value: number) => Number.isSafeInteger(value) && value >= 1
  if (
    !isPositiveInteger(maxConcurrentRequests) ||
    !isPositiveInteger(maxConcurrentRequestsPerCall) ||
    !isPositiveInteger(operationTimeoutMs) ||
    operationTimeoutMs > MAX_TIMER_DELAY_MS
  ) {
    throw new RangeError(`Límites del almacenamiento inválidos: ${JSON.stringify(limits)}`)
  }
  return limits
}

/**
 * Lo que nunca va en un nombre de descarga: controles C0, DEL y C1 (`\p{Cc}`), comillas, barras y
 * surrogates UTF-16 sueltos (`\p{Cs}`). Con la bandera `u` la expresión recorre puntos de código: un
 * par bien formado es un solo carácter fuera del plano básico y no coincide con `\p{Cs}`.
 */
const UNSAFE_DOWNLOAD_NAME_CHARS = /[\p{Cc}\p{Cs}"\\/]/gu

/**
 * `Content-Disposition` de descarga (RFC 6266): `filename` en ASCII para cualquier navegador y
 * `filename*` en UTF-8 cuando el nombre tiene tildes. Acepta cualquier texto y nunca lanza: cambia
 * por `_` las comillas, las barras, los caracteres de control y los surrogates sueltos (con los que
 * `encodeURIComponent` lanzaría `URIError`), así que un nombre nunca inyecta otra cabecera ni una ruta.
 */
export function buildContentDisposition(downloadName: string): string {
  const name = sanitizeDownloadName(downloadName)
  const ascii = asciiDownloadName(name)
  if (ascii === name) return `attachment; filename="${ascii}"`
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(name)}`
}

/** En NFC, sin caracteres inseguros, recortado a `MAX_DOWNLOAD_NAME_LENGTH` caracteres y nunca vacío. */
function sanitizeDownloadName(downloadName: string): string {
  const safe = downloadName.normalize('NFC').replace(UNSAFE_DOWNLOAD_NAME_CHARS, '_')
  // El recorte cuenta puntos de código: nunca parte un par de surrogates.
  const name = [...safe].slice(0, MAX_DOWNLOAD_NAME_LENGTH).join('').trim()
  return name === '' ? FALLBACK_DOWNLOAD_NAME : name
}

/**
 * Versión ASCII del nombre ya saneado: sin tildes y con un `_` por cada carácter que no sea ASCII
 * imprimible. Si no queda nada (un nombre hecho solo de marcas combinantes), `archivo`.
 */
function asciiDownloadName(name: string): string {
  const ascii = name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\x20-\x7e]/gu, '_')
    .trim()
  return ascii === '' ? FALLBACK_DOWNLOAD_NAME : ascii
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/** Corte por tiempo: el plazo del adaptador o los topes de conexión y petición del SDK. */
function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError'
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
