import { isIP } from 'node:net'
import { z } from 'zod'
import { flag, integer } from './env-values.js'

const NAMED_PROXY_SUBNETS = new Set(['loopback', 'linklocal', 'uniquelocal'])

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

/** Transporte HTTP: CORS, proxies de confianza y tiempos del servidor de Node. */
export const httpShape = {
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:4321,http://localhost:3000')
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
    }),
  TRUST_PROXY: z
    .string()
    .default('loopback')
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
    }),
  TRUST_CLOUDFLARE_HEADERS: flag(false),
  SERVER_REQUEST_TIMEOUT_MS: integer({ fallback: 120_000, min: 1_000, max: 3_600_000 }),
  SERVER_HEADERS_TIMEOUT_MS: integer({ fallback: 20_000, min: 1_000, max: 600_000 }),
  SERVER_KEEP_ALIVE_TIMEOUT_MS: integer({ fallback: 65_000, min: 1_000, max: 600_000 }),
}

const httpSchema = z.object(httpShape)
export type HttpEnvironment = z.output<typeof httpSchema>

export function refineHttp(env: HttpEnvironment, ctx: z.RefinementCtx): void {
  if (env.SERVER_HEADERS_TIMEOUT_MS > env.SERVER_REQUEST_TIMEOUT_MS) {
    ctx.addIssue({
      code: 'custom',
      path: ['SERVER_HEADERS_TIMEOUT_MS'],
      message: 'debe ser menor o igual que SERVER_REQUEST_TIMEOUT_MS',
    })
  }
}

export function toHttpConfig(env: HttpEnvironment) {
  return {
    corsOrigins: env.CORS_ORIGINS,
    trustProxy: env.TRUST_PROXY,
    trustCloudflareHeaders: env.TRUST_CLOUDFLARE_HEADERS,
    server: {
      requestTimeoutMs: env.SERVER_REQUEST_TIMEOUT_MS,
      headersTimeoutMs: env.SERVER_HEADERS_TIMEOUT_MS,
      keepAliveTimeoutMs: env.SERVER_KEEP_ALIVE_TIMEOUT_MS,
    },
  }
}
