import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Params } from 'nestjs-pino'
import type { AppConfig } from '#/common/config/index.js'
import { resolveCorrelationId } from '#/common/utils/correlation-id.js'
import { HEALTH_PATHS } from './constants.js'

const HEALTH_URLS = new Set<string>(Object.values(HEALTH_PATHS).map((path) => `/${path}`))

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Nivel del log de cada respuesta. Sin esto pino-http escribe todo en `info`, un 500 incluido, y el
 * nivel deja de servir para alertar.
 */
export function resolveHttpLogLevel(
  _req: IncomingMessage,
  res: ServerResponse,
  error?: Error,
): 'error' | 'warn' | 'info' {
  if (error !== undefined || res.statusCode >= 500) return 'error'
  if (res.statusCode >= 400) return 'warn'
  return 'info'
}

/**
 * El patrón de la ruta que atendió la petición (`/api/v1/payers`), nunca la URL: la URL puede traer
 * ids y una query que escribe el cliente. Un 404 lo atiende el comodín de Nest (`/api*path`): no es
 * una ruta de la API y no se registra.
 */
export function resolveLogRoute(req: IncomingMessage): string | undefined {
  const routed = req as IncomingMessage & { baseUrl?: unknown; route?: { path?: unknown } }
  const path = routed.route?.path
  if (typeof path !== 'string' || path.includes('*')) return undefined
  return `${typeof routed.baseUrl === 'string' ? routed.baseUrl : ''}${path}`
}

/** Del request solo el método: ni URL, ni cabeceras, ni IP, ni user agent (datos personales). */
export function serializeSafeRequest(value: unknown): { method: string } {
  const method = isRecord(value) && typeof value.method === 'string' ? value.method : 'UNKNOWN'
  return { method: /^[A-Z]{3,16}$/.test(method) ? method : 'UNKNOWN' }
}

/** De la respuesta solo el estado HTTP. */
export function serializeSafeResponse(value: unknown): { statusCode: number | null } {
  const statusCode = isRecord(value) ? value.statusCode : undefined
  return { statusCode: typeof statusCode === 'number' ? statusCode : null }
}

/**
 * De un error solo su clase y su código: el mensaje y la pila de una librería pueden traer SQL, los
 * argumentos de una consulta de Prisma o el cuerpo de la petición, con datos personales.
 */
export function serializeSafeError(value: unknown): { type: string; code?: string } {
  if (!(value instanceof Error)) return { type: 'Error' }
  const code = (value as Error & { code?: unknown }).code
  return typeof code === 'string' ? { type: value.name, code } : { type: value.name }
}

/** Las sondas no se registran: el monitoreo las llama cada pocos segundos. */
export function isHealthRequest(req: IncomingMessage): boolean {
  return HEALTH_URLS.has((req.url ?? '').split('?')[0] ?? '')
}

/**
 * Logger HTTP (nestjs-pino). El id de cada petición es su id de correlación (`resolveCorrelationId`),
 * el mismo de la cabecera `x-correlation-id`. En desarrollo, salida legible con pino-pretty.
 */
export function createPinoHttpOptions(config: Pick<AppConfig, 'logLevel' | 'nodeEnv'>): Params {
  return {
    pinoHttp: {
      level: config.logLevel,
      genReqId: (req) => resolveCorrelationId(req),
      customLogLevel: resolveHttpLogLevel,
      customProps: (req) => ({
        correlationId: resolveCorrelationId(req),
        route: resolveLogRoute(req),
      }),
      serializers: {
        req: serializeSafeRequest,
        res: serializeSafeResponse,
        err: serializeSafeError,
      },
      autoLogging: { ignore: isHealthRequest },
      ...(config.nodeEnv === 'development'
        ? {
            transport: {
              target: 'pino-pretty',
              options: { singleLine: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
            },
          }
        : {}),
    },
  }
}
