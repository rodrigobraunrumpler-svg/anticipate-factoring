import { isIP } from 'node:net'
import { z } from 'zod'
import { integer } from './env-values.js'
import type { RuntimeEnvironment } from './runtime.schema.js'

const NAMED_PROXY_SUBNETS = new Set(['loopback', 'linklocal', 'uniquelocal'])

/**
 * Valores de desarrollo de las variables HTTP. Fuera de producción se usan si la variable falta; en
 * producción cada una es obligatoria (`refineHttp`): con estos valores, detrás del proxy de STACK §12,
 * el navegador bloquea los envíos de la landing real y todos los visitantes comparten la IP del proxy.
 */
export const DEVELOPMENT_CORS_ORIGINS = ['http://localhost:4321', 'http://localhost:3000'] as const
export const DEVELOPMENT_TRUST_PROXY = 'loopback'
export const DEVELOPMENT_TRUST_CLOUDFLARE_HEADERS = false

/** Un origen exacto: esquema, host y puerto, sin ruta ni barra final, como lo envía el navegador. */
function isExactOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value
  } catch {
    return false
  }
}

function parseOrigins(value: string): string[] | null {
  const origins = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
  if (origins.length === 0 || !origins.every(isExactOrigin)) return null
  return [...new Set(origins)]
}

/** `loopback`, una IP (`10.0.0.2`) o una subred CIDR (`10.0.0.0/8`, `fd00::/8`). */
function isTrustedProxyEntry(entry: string): boolean {
  if (NAMED_PROXY_SUBNETS.has(entry)) return true
  const [address = '', bits, ...rest] = entry.split('/')
  const version = isIP(address)
  if (version === 0 || rest.length > 0) return false
  if (bits === undefined) return true
  return /^\d{1,3}$/.test(bits) && Number(bits) <= (version === 4 ? 32 : 128)
}

/**
 * Lo que entiende `app.set('trust proxy', valor)` de Express: `false`, el número de proxies delante de la
 * API o una lista de subredes. Nunca `true`: confiaría en cualquier `X-Forwarded-For` y cualquiera
 * podría elegir su IP (y con ella, su cupo del límite de envíos).
 */
function parseTrustProxy(raw: string): false | number | string | null {
  const value = raw.trim()
  if (value === 'false') return false
  if (/^\d+$/.test(value)) return Number(value)
  const entries = value.split(',').map((entry) => entry.trim())
  return entries.every(isTrustedProxyEntry) ? entries.join(',') : null
}

/** `localhost`, un subdominio de `.localhost`, una IP de loopback (`127.0.0.0/8`, `::1`) o la IP sin especificar. */
function isLocalHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1' || host === '::' || host === '0.0.0.0') return true
  return isIP(host) === 4 && host.startsWith('127.')
}

/** Un origen que un navegador de la landing o del admin publicados puede enviar: https y no local. */
function isPublishedOrigin(origin: string): boolean {
  const url = new URL(origin)
  return url.protocol === 'https:' && !isLocalHostname(url.hostname)
}

/**
 * Transporte HTTP: CORS, proxies de confianza y tiempos del servidor de Node. `CORS_ORIGINS`,
 * `TRUST_PROXY` y `TRUST_CLOUDFLARE_HEADERS` no tienen valor por defecto en el esquema: fuera de
 * producción `toHttpConfig` usa los de desarrollo y en producción `refineHttp` exige cada una.
 */
export const httpShape = {
  CORS_ORIGINS: z
    .string()
    .transform((value, ctx) => {
      const origins = parseOrigins(value)
      if (origins === null) {
        ctx.addIssue({
          code: 'custom',
          message:
            'debe ser una lista de orígenes exactos separados por comas (https://anticipate.pe), sin ruta ni barra final',
        })
        return z.NEVER
      }
      return origins
    })
    .optional(),
  TRUST_PROXY: z
    .string()
    .transform((value, ctx) => {
      const trustProxy = parseTrustProxy(value)
      if (trustProxy === null) {
        ctx.addIssue({
          code: 'custom',
          message:
            'debe ser false, el número de proxies delante de la API o una lista de subredes (loopback, 10.0.0.0/8); nunca true',
        })
        return z.NEVER
      }
      return trustProxy
    })
    .optional(),
  TRUST_CLOUDFLARE_HEADERS: z
    .enum(['true', 'false'], { error: 'debe ser true o false' })
    .transform((value) => value === 'true')
    .optional(),
  SERVER_REQUEST_TIMEOUT_MS: integer({ fallback: 120_000, min: 1_000, max: 3_600_000 }),
  SERVER_HEADERS_TIMEOUT_MS: integer({ fallback: 20_000, min: 1_000, max: 600_000 }),
  SERVER_KEEP_ALIVE_TIMEOUT_MS: integer({ fallback: 65_000, min: 1_000, max: 600_000 }),
}

const httpSchema = z.object(httpShape)
export type HttpEnvironment = z.output<typeof httpSchema>

/** Por qué cada variable HTTP sin valor por defecto es obligatoria en producción. */
const PRODUCTION_REQUIRED_MESSAGES = {
  CORS_ORIGINS:
    'es obligatoria en producción: los orígenes de la landing y del admin (https://anticipate.pe,https://admin.anticipate.pe); con los de desarrollo el navegador bloquea cada envío',
  TRUST_PROXY:
    'es obligatoria en producción: los proxies delante de la API (docs/STACK.md, sección 12); con el valor de desarrollo detrás de un proxy todos los visitantes comparten su IP (un solo cupo del límite de envíos y la IP del proxy en los consentimientos)',
  TRUST_CLOUDFLARE_HEADERS:
    'es obligatoria en producción: true si el servidor solo acepta tráfico de Cloudflare, false si no (docs/STACK.md, sección 12)',
} as const

export function refineHttp(
  env: HttpEnvironment & Pick<RuntimeEnvironment, 'NODE_ENV'>,
  ctx: z.RefinementCtx,
): void {
  if (env.SERVER_HEADERS_TIMEOUT_MS > env.SERVER_REQUEST_TIMEOUT_MS) {
    ctx.addIssue({
      code: 'custom',
      path: ['SERVER_HEADERS_TIMEOUT_MS'],
      message: 'debe ser menor o igual que SERVER_REQUEST_TIMEOUT_MS',
    })
  }
  if (env.NODE_ENV !== 'production') return
  // Un olvido aquí no se ve: la API arranca, la readiness sale bien y la prueba de humo (sin
  // navegador) pasa, pero el navegador bloquea los envíos o todos los visitantes comparten una IP.
  for (const key of ['CORS_ORIGINS', 'TRUST_PROXY', 'TRUST_CLOUDFLARE_HEADERS'] as const) {
    if (env[key] === undefined) {
      ctx.addIssue({ code: 'custom', path: [key], message: PRODUCTION_REQUIRED_MESSAGES[key] })
    }
  }
  if (env.CORS_ORIGINS !== undefined && !env.CORS_ORIGINS.every(isPublishedOrigin)) {
    ctx.addIssue({
      code: 'custom',
      path: ['CORS_ORIGINS'],
      message:
        'en producción cada origen debe ser https y no puede ser localhost ni una IP de loopback: son los de la landing y el admin publicados (https://anticipate.pe)',
    })
  }
}

export function toHttpConfig(env: HttpEnvironment) {
  return {
    corsOrigins: env.CORS_ORIGINS ?? [...DEVELOPMENT_CORS_ORIGINS],
    trustProxy: env.TRUST_PROXY ?? DEVELOPMENT_TRUST_PROXY,
    trustCloudflareHeaders: env.TRUST_CLOUDFLARE_HEADERS ?? DEVELOPMENT_TRUST_CLOUDFLARE_HEADERS,
    server: {
      requestTimeoutMs: env.SERVER_REQUEST_TIMEOUT_MS,
      headersTimeoutMs: env.SERVER_HEADERS_TIMEOUT_MS,
      keepAliveTimeoutMs: env.SERVER_KEEP_ALIVE_TIMEOUT_MS,
    },
  }
}
