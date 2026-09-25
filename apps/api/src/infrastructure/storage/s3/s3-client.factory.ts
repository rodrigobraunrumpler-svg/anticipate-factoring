import { S3Client } from '@aws-sdk/client-s3'

/** Cliente S3 único del proceso. Solo lo usan el adaptador y el indicador de este módulo. */
export const S3_CLIENT = Symbol('S3_CLIENT')

/** Conexión al almacenamiento; `AppConfig['storage']` la cumple tal cual. */
export type S3ConnectionSettings = {
  readonly endpoint?: string | undefined
  readonly region: string
  readonly forcePathStyle: boolean
  readonly accessKeyId: string
  readonly secretAccessKey: string
}

/** Límites técnicos del cliente. No cambian por entorno; los tests usan valores cortos. */
export type S3ClientTuning = {
  readonly connectionTimeoutMs: number
  readonly requestTimeoutMs: number
  readonly maxAttempts: number
}

/**
 * 30 s por intento alcanzan para subir los 95 MB de un envío a más de 3,2 MB/s; con 3 intentos, un
 * proveedor colgado responde con error en menos de 2 minutos en vez de retener la solicitud.
 */
export const S3_CLIENT_TUNING: S3ClientTuning = Object.freeze({
  connectionTimeoutMs: 5_000,
  requestTimeoutMs: 30_000,
  maxAttempts: 3,
})

export function createS3Client(
  settings: S3ConnectionSettings,
  tuning: S3ClientTuning = S3_CLIENT_TUNING,
): S3Client {
  return new S3Client({
    ...(settings.endpoint === undefined ? {} : { endpoint: settings.endpoint }),
    region: settings.region,
    forcePathStyle: settings.forcePathStyle,
    credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
    // R2 no documenta el trailer aws-chunked ni las sumas por defecto del SDK: un solo camino de
    // código, probado contra S3Mock y recomendado por AWS para servicios compatibles.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: tuning.maxAttempts,
    requestHandler: {
      connectionTimeout: tuning.connectionTimeoutMs,
      requestTimeout: tuning.requestTimeoutMs,
      // Sin esta opción el SDK solo avisa en el log y la petición sigue colgada (comprobado).
      throwOnRequestTimeout: true,
    },
  })
}
