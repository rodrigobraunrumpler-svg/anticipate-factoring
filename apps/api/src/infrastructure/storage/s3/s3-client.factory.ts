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
  /**
   * Tope para abrir la conexión TCP. El SDK lo cuenta desde que crea la petición, no desde que el
   * pool le asigna un socket: una petición que espera socket gasta este tiempo esperando. Por eso
   * el adaptador nunca tiene más peticiones en curso que `maxSockets`.
   */
  readonly connectionTimeoutMs: number
  /** Tope de cada intento hasta recibir las cabeceras de la respuesta (el cuerpo no cuenta). */
  readonly requestTimeoutMs: number
  readonly maxAttempts: number
  /** Sockets simultáneos del pool keep-alive por origen; lo que pase de aquí espera en cola. */
  readonly maxSockets: number
}

/**
 * 30 s por intento alcanzan para subir los 95 MB de un envío a más de 3,2 MB/s. El SDK no corta un
 * cuerpo de respuesta que se queda a medias: ese tope lo pone el plazo por operación del adaptador
 * (`S3_REQUEST_LIMITS.operationTimeoutMs`), que cubre los 3 intentos y la lectura de la respuesta.
 *
 * Sin `socketTimeout` a propósito: en `@smithy/node-http-handler` 4.12, un valor de 6 s o más se
 * registra recién a los 3 s y se cancela si las cabeceras llegaron antes, así que no cubre el cuerpo
 * (comprobado: con 6000 ms, una respuesta que se cuelga tras las cabeceras sigue pendiente a los
 * 9 s). Uno menor cortaría esperas legítimas antes de las cabeceras, como el `100-continue` de las
 * subidas de 2 MB o más, más pronto que `requestTimeoutMs`.
 *
 * `maxSockets` es el valor del SDK, explícito: el adaptador se queda por debajo y la readiness
 * siempre encuentra un socket libre.
 */
export const S3_CLIENT_TUNING: S3ClientTuning = Object.freeze({
  connectionTimeoutMs: 5_000,
  requestTimeoutMs: 30_000,
  maxAttempts: 3,
  maxSockets: 50,
})

export function createS3Client(
  settings: S3ConnectionSettings,
  tuning: S3ClientTuning = S3_CLIENT_TUNING,
): S3Client {
  // Opciones y no instancias de Agent: con un Agent propio el SDK deja de esperar el `100-continue`
  // de las subidas grandes. Sobre HTTP (S3Mock) el SDK crea el agente en la primera petición y una
  // primera ráfaga puede pasar de `maxSockets`; el tope del adaptador acota igual lo que sale.
  const agent = { maxSockets: tuning.maxSockets }
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
      httpAgent: agent,
      httpsAgent: agent,
    },
  })
}
