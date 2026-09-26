import { availableParallelism } from 'node:os'
import { z } from 'zod'
import { integer } from './env-values.js'

/**
 * Hilos del lector de XML por defecto: uno menos que los núcleos disponibles (el principal atiende las
 * peticiones), al menos 1 y como mucho 4. El tope acota la memoria: cada hilo puede llegar a
 * `XML_PARSE_WORKER_HEAP_MB`, y en un contenedor `availableParallelism()` puede contar los núcleos del
 * host y no la cuota del contenedor. Un servidor mayor lo sube con `XML_PARSE_WORKERS`.
 */
export function defaultXmlParseWorkers(cores: number): number {
  return Math.max(1, Math.min(4, cores - 1))
}

/**
 * Lector de XML de facturas fuera del hilo principal (pool de `worker_threads`, D53): hilos, plazo y
 * heap de cada lectura, y la cola que espera un hilo libre. Un XML que pasa el plazo o el heap es
 * `UNREADABLE_XML`; con la cola llena o la espera vencida, la solicitud es 503.
 */
export const xmlParserShape = {
  XML_PARSE_WORKERS: integer({
    fallback: defaultXmlParseWorkers(availableParallelism()),
    min: 1,
    max: 32,
  }),
  XML_PARSE_TIMEOUT_MS: integer({ fallback: 2_000, min: 100, max: 60_000 }),
  XML_PARSE_WORKER_HEAP_MB: integer({ fallback: 128, min: 64, max: 4_096 }),
  XML_PARSE_QUEUE_LIMIT: integer({ fallback: 32, min: 1, max: 10_000 }),
  XML_PARSE_QUEUE_TIMEOUT_MS: integer({ fallback: 10_000, min: 100, max: 120_000 }),
}

const xmlParserSchema = z.object(xmlParserShape)
export type XmlParserEnvironment = z.output<typeof xmlParserSchema>

export function toXmlParserConfig(env: XmlParserEnvironment) {
  return {
    xmlParser: {
      workers: env.XML_PARSE_WORKERS,
      timeoutMs: env.XML_PARSE_TIMEOUT_MS,
      workerHeapMb: env.XML_PARSE_WORKER_HEAP_MB,
      queueLimit: env.XML_PARSE_QUEUE_LIMIT,
      queueTimeoutMs: env.XML_PARSE_QUEUE_TIMEOUT_MS,
    },
  }
}
