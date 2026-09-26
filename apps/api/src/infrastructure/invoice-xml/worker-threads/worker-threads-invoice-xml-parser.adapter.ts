import type { ParseResult } from '@anticipate/shared/invoice'
import { Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common'
import type {
  InvoiceXmlParseOutcome,
  InvoiceXmlParserPort,
} from '#/modules/advance-requests/index.js'
import type { InvoiceXmlParseTask } from './invoice-xml-parser.protocol.js'
import { WorkerPool, type WorkerPoolStats } from './worker-pool.js'

/** Topes del lector, de la configuración `xmlParser` (`XML_PARSE_*`). */
export type InvoiceXmlParserOptions = {
  /** Hilos que leen XML a la vez. */
  readonly workers: number
  /** Plazo de la lectura de un XML, desde que un hilo la empieza. */
  readonly timeoutMs: number
  /** Heap de cada hilo (generación vieja de V8), en MiB. */
  readonly workerHeapMb: number
  /** XML esperando un hilo libre. */
  readonly queueLimit: number
  /** Espera máxima de un XML por un hilo libre. */
  readonly queueTimeoutMs: number
}

/**
 * Generación joven de cada hilo, en MiB. Sin tope, V8 la agranda tanto que un hilo que lee un XML
 * hostil de 1 MiB llegaba a unos 280 MiB sobre la base con `workerHeapMb` 128; con 32, a unos 145, a
 * cambio de un 10 % más de tiempo de lectura (medido en la revisión final, D53).
 */
const WORKER_YOUNG_GENERATION_MB = 32

/**
 * El script del worker, junto a este archivo: `.ts` cuando corre desde `src` (Vitest; Node le quita los
 * tipos) y `.js` desde `dist` (`node dist/main.js` y la imagen).
 */
function workerScript(): URL {
  const extension = new URL(import.meta.url).pathname.endsWith('.ts') ? '.ts' : '.js'
  return new URL(`./invoice-xml-parser.worker${extension}`, import.meta.url)
}

/**
 * Los bytes que viajan al worker. `postMessage` copia el `ArrayBuffer` entero detrás de una vista: un
 * `Buffer` chico de multer vive en el bloque compartido de Node (`Buffer.poolSize`), y una vista
 * cualquiera podría estar sobre algo mucho mayor. Si la vista no cubre su buffer entero, viaja una
 * copia exacta. Nunca se transfiere: el buffer de quien llama sigue suyo (después se sube al
 * almacenamiento).
 */
export function bytesForWorker(xml: Uint8Array): Uint8Array {
  const whole =
    xml.buffer instanceof ArrayBuffer &&
    xml.byteOffset === 0 &&
    xml.byteLength === xml.buffer.byteLength
  return whole ? xml : new Uint8Array(xml)
}

/**
 * `InvoiceXmlParserPort` con un pool de `worker_threads` (`WorkerPool`). El hilo principal solo copia
 * los bytes y recibe un resultado chico; la lectura (medio segundo o más de CPU para un XML hostil de
 * 1 MiB) corre en otro hilo, con plazo y tope de memoria propios. Arranca un hilo al iniciar la
 * aplicación, así un script que no carga detiene el arranque y no la primera solicitud, y termina todos
 * al apagarse.
 */
export class WorkerThreadsInvoiceXmlParser
  implements InvoiceXmlParserPort, OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(WorkerThreadsInvoiceXmlParser.name)
  private readonly options: InvoiceXmlParserOptions
  private readonly pool: WorkerPool<InvoiceXmlParseTask, ParseResult>

  constructor(options: InvoiceXmlParserOptions) {
    this.options = options
    this.pool = new WorkerPool({
      script: workerScript(),
      name: 'invoice-xml-parser',
      maxWorkers: options.workers,
      maxQueued: options.queueLimit,
      queueTimeoutMs: options.queueTimeoutMs,
      taskTimeoutMs: options.timeoutMs,
      maxHeapMb: options.workerHeapMb,
      maxYoungGenerationMb: WORKER_YOUNG_GENERATION_MB,
      onStartFailure: (error) => {
        this.logger.error(`No arrancó un worker del lector de XML: ${error.message}`, error.stack)
      },
    })
  }

  /** Hilos y cola del pool, para los tests y el diagnóstico. */
  get stats(): WorkerPoolStats {
    return this.pool.stats
  }

  start(): Promise<void> {
    return this.pool.start()
  }

  close(): Promise<void> {
    return this.pool.close()
  }

  async onModuleInit(): Promise<void> {
    await this.start()
  }

  async onApplicationShutdown(): Promise<void> {
    await this.close()
  }

  async parse(
    xml: Uint8Array,
    { maxLength }: { readonly maxLength: number },
  ): Promise<InvoiceXmlParseOutcome> {
    const outcome = await this.pool.run({ xml: bytesForWorker(xml), maxLength })
    switch (outcome.status) {
      case 'completed':
        return { status: 'parsed', result: outcome.value }
      case 'timed-out':
        this.logger.warn(
          `Un XML superó el plazo de lectura (${this.options.timeoutMs} ms): se terminó su worker y se reemplaza`,
        )
        return { status: 'too-expensive', reason: 'timeout' }
      case 'out-of-memory':
        this.logger.warn(
          `Un XML superó el tope de memoria del lector (${this.options.workerHeapMb} MiB): se terminó su worker y se reemplaza`,
        )
        return { status: 'too-expensive', reason: 'memory' }
      case 'rejected':
        return this.unavailable(outcome.reason)
    }
  }

  private unavailable(
    reason: 'queue-full' | 'queue-timeout' | 'start-failed' | 'closed',
  ): InvoiceXmlParseOutcome {
    if (reason === 'closed') return { status: 'unavailable', reason: 'shutting-down' }
    if (reason === 'start-failed') return { status: 'unavailable', reason: 'start-failed' }
    const { workers, busy, queued } = this.pool.stats
    this.logger.warn(
      `Lector de XML saturado (${reason === 'queue-full' ? 'cola llena' : 'espera vencida'}): ${busy} de ${workers} workers ocupados, ${queued} XML en cola`,
    )
    return { status: 'unavailable', reason: 'saturated' }
  }
}
