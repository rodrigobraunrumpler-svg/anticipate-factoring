import { ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3'
import type { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus'

export type S3ReadinessOptions = {
  readonly bucket: string
  /** Tope de la consulta; pasado este tiempo el almacenamiento cuenta como caído. */
  readonly timeoutMs: number
  /** Un resultado se reutiliza durante este tiempo: una ráfaga de sondeos hace una sola consulta. */
  readonly cacheTtlMs: number
}

export const S3_READINESS_TIMEOUT_MS = 2_000
export const S3_READINESS_CACHE_TTL_MS = 5_000
/** Margen del tope de Terminus sobre el propio: solo actúa si el SDK no respeta la cancelación. */
const HARD_TIMEOUT_MARGIN_MS = 500

export const STORAGE_UNAVAILABLE_MESSAGE =
  'El almacenamiento rechazó la consulta o no está disponible.'
export const storageTimeoutMessage = (timeoutMs: number) =>
  `El almacenamiento no respondió en ${timeoutMs} ms.`

/**
 * Readiness del almacenamiento. Lista como máximo una clave del bucket: es lo mínimo que distingue
 * un bucket inexistente o credenciales rechazadas, y lo permite un token de R2 de solo objetos
 * (`HeadBucket` puede exigir permisos de administrador). El mensaje nunca incluye el error del
 * proveedor, que puede traer hosts o la cuenta: la ruta es pública.
 */
export class S3ReadinessIndicator {
  constructor(
    private readonly client: S3Client,
    private readonly indicators: HealthIndicatorService,
    private readonly options: S3ReadinessOptions,
  ) {}

  async check(key: string): Promise<HealthIndicatorResult> {
    const { bucket, timeoutMs, cacheTtlMs } = this.options
    return this.indicators
      .check(key)
      .attempt(async () => {
        try {
          await this.client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }), {
            abortSignal: AbortSignal.timeout(timeoutMs),
          })
        } catch (error) {
          const timedOut = error instanceof Error && error.name === 'AbortError'
          throw new Error(timedOut ? storageTimeoutMessage(timeoutMs) : STORAGE_UNAVAILABLE_MESSAGE)
        }
      })
      .withTimeout(timeoutMs + HARD_TIMEOUT_MARGIN_MS)
      .cacheFor(cacheTtlMs)
  }
}
