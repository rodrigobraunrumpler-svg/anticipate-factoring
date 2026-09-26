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
import { withDeadline } from './deadline.js'
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
   * la lectura de la respuesta. Al vencer, la operación rechaza y libera el cupo en ese momento,
   * aunque el SDK esté esperando para reintentar; corta también lo que el SDK deja colgado, como una
   * respuesta que manda las cabeceras y no termina el cuerpo.
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

/** Una clave que el adaptador no manda al proveedor. El mensaje dice por qué, sin repetir la clave. */
export class InvalidObjectKeyError extends Error {
  constructor(problem: string) {
    super(`Clave de objeto inválida: ${problem}.`)
    this.name = 'InvalidObjectKeyError'
  }
}

/** Largo máximo de una clave en S3 y en R2, en bytes UTF-8. */
const MAX_OBJECT_KEY_BYTES = 1_024

/**
 * Controles C0, DEL y C1 (`\p{Cc}`) y surrogates UTF-16 sueltos (`\p{Cs}`): con la bandera `u` un par
 * bien formado es un solo carácter y no coincide.
 */
const FORBIDDEN_OBJECT_KEY_CHARS = /[\p{Cc}\p{Cs}]/u

/**
 * Por qué `key` no sirve como clave de objeto, o `undefined` si sirve. Las reglas son las de
 * `FileStoragePort`: con una clave vacía el SDK arma la ruta del bucket y la operación deja de ser
 * sobre un objeto (`DeleteObject` pasa a borrar el bucket, `HeadObject` a consultarlo y un `GetObject`
 * firmado a listar todas sus claves); los segmentos vacíos, `.` y `..` son rutas que un proxy o el
 * proveedor pueden normalizar hacia otra clave o hacia el bucket. Nunca lanza, reciba lo que reciba.
 * La base aplica la misma regla a `stored_files.key` (`stored_files_key_check`); el test estructural
 * compara las dos: si cambia una, cambia la otra con una migración.
 */
export function objectKeyProblem(key: string): string | undefined {
  if (typeof key !== 'string') return 'no es texto'
  if (key === '') return 'está vacía'
  if (FORBIDDEN_OBJECT_KEY_CHARS.test(key)) {
    return 'tiene caracteres de control o surrogates UTF-16 sueltos'
  }
  if (Buffer.byteLength(key, 'utf8') > MAX_OBJECT_KEY_BYTES) {
    return `pasa de ${MAX_OBJECT_KEY_BYTES} bytes en UTF-8`
  }
  if (key.startsWith('/')) return 'empieza con "/"'
  for (const segment of key.split('/')) {
    if (segment === '') return 'tiene un segmento vacío ("//" o "/" al final)'
    if (segment === '.' || segment === '..') return 'tiene un segmento "." o ".."'
  }
  return undefined
}

function assertObjectKey(key: string): void {
  const problem = objectKeyProblem(key)
  if (problem !== undefined) throw new InvalidObjectKeyError(problem)
}

/**
 * Cada clave válida y ninguna repetida: dos entradas con la misma clave serían un objeto con dos
 * contenidos y dos resultados que se contradicen.
 */
function assertUploadKeys(inputs: readonly PutFileInput[]): void {
  const seen = new Set<string>()
  for (const { key } of inputs) {
    assertObjectKey(key)
    if (seen.has(key)) throw new InvalidObjectKeyError('está repetida en la misma subida')
    seen.add(key)
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
    // Antes de subir nada: una entrada inválida rechaza sin que llegue ninguna al proveedor.
    assertUploadKeys(inputs)
    const stored: Array<StoredObject | undefined> = inputs.map(() => undefined)
    // Las claves que se mandaron, hayan terminado bien o no: una subida que venció o se cortó pudo
    // quedar guardada igual. Las claves son nuevas, así que borrarlas nunca pisa otro archivo.
    const attempted: string[] = []
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
            (abortSignal) => {
              attempted.push(input.key)
              return this.put(input, abortSignal)
            },
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

    const notDeleted = await this.deleteQuietly(attempted)
    this.logger.warn(
      {
        failed,
        uploaded: uploaded.length,
        notStarted: inputs.length - attempted.length,
        notDeleted: notDeleted.length,
        error: describeError(firstFailure.error),
      },
      'Falló una subida; se intentó borrar todas las que se mandaron.',
    )
    throw firstFailure.error
  }

  async deleteQuietly(keys: readonly string[]): Promise<string[]> {
    const unique = [...new Set(keys)]
    const notDeleted = new Set<string>()
    const valid: string[] = []
    for (const key of unique) {
      const problem = objectKeyProblem(key)
      if (problem === undefined) {
        valid.push(key)
        continue
      }
      // Nunca llega al proveedor: queda pendiente y a la vista en el log hasta que alguien la corrija.
      notDeleted.add(key)
      this.logger.warn(
        { key, problem },
        'Clave de objeto inválida: no se manda al almacenamiento y queda pendiente.',
      )
    }
    // Si el proveedor deja de responder, cada borrado esperaría su plazo entero: no se mandan más y
    // lo que falta queda pendiente para la próxima pasada.
    let unresponsive = false
    let skipped = 0
    await forEachConcurrently(valid, this.limits.maxConcurrentRequestsPerCall, async (key) => {
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
    assertObjectKey(key)
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
   * `async` a propósito: cualquier falla, también una clave inválida o el armado de la cabecera antes
   * de firmar, llega como promesa rechazada y nunca como excepción síncrona que un `.catch()`
   * encadenado no ve.
   */
  async downloadUrl(key: string, downloadName: string): Promise<string> {
    // Con una clave vacía, el enlace firmado listaría todas las claves del bucket.
    assertObjectKey(key)
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
   * Una petición al proveedor: espera un cupo del tope global y rechaza con
   * `StorageOperationTimeoutError` si no termina en `operationTimeoutMs`, contado desde que obtuvo el
   * cupo. Al vencer, rechaza y libera el cupo en ese mismo momento, aunque el SDK esté esperando para
   * reintentar; la señal ya cancelada hace que el SDK no mande otro intento. Si al obtener el cupo
   * `wanted` dice que ya no hace falta, no la manda y resuelve `SKIPPED`. `onFailure` corre antes de
   * liberar el cupo: la petición que lo recibe ya ve el fallo en su `wanted`.
   */
  private request<T>(
    operation: string,
    send: (abortSignal: AbortSignal) => Promise<T>,
    control: RequestControl = {},
  ): Promise<T | typeof SKIPPED> {
    return this.requests.run(async () => {
      if (control.wanted?.() === false) return SKIPPED
      const { operationTimeoutMs } = this.limits
      try {
        return await withDeadline(
          operationTimeoutMs,
          send,
          () => new StorageOperationTimeoutError(operation, operationTimeoutMs),
        )
      } catch (error) {
        control.onFailure?.(error)
        throw error
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
 * Lo que nunca va en un nombre de descarga: controles C0, DEL y C1 (`\p{Cc}`), caracteres de formato
 * (`\p{Cf}`: U+202E y demás controles de dirección, que harían ver `factura\u202Efdp.exe` como
 * `facturaexe.pdf`, y los de ancho cero), separadores de línea y de párrafo (`\p{Zl}`, `\p{Zp}`),
 * comillas, barras y surrogates UTF-16 sueltos (`\p{Cs}`). Con la bandera `u` la expresión recorre
 * puntos de código: un par bien formado es un solo carácter fuera del plano básico y no coincide con
 * `\p{Cs}`.
 */
const UNSAFE_DOWNLOAD_NAME_CHARS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}"\\/]/gu

/**
 * `Content-Disposition` de descarga (RFC 6266): `filename` en ASCII para cualquier navegador y
 * `filename*` en UTF-8 cuando el nombre tiene tildes. Acepta cualquier texto y nunca lanza: cambia
 * por `_` las comillas, las barras, los caracteres de control y de formato, los separadores de línea
 * y de párrafo y los surrogates sueltos (con los que `encodeURIComponent` lanzaría `URIError`), así
 * que un nombre nunca inyecta otra cabecera ni una ruta, ni disfraza su extensión.
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
