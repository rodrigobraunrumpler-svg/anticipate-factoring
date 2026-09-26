import { isIP } from 'node:net'
import type { Request } from 'express'

/** Cabecera con la IP del visitante que agrega Cloudflare delante del origen. */
const CLOUDFLARE_CLIENT_IP_HEADER = 'cf-connecting-ip'

/** Cabecera que agrega un proxy inverso con la IP de quien le habló. */
const FORWARDED_FOR_HEADER = 'x-forwarded-for'

/**
 * IP que se usa si la del cliente no se conoce: la conexión ya no tiene dirección (socket cerrado) o
 * la que dio el proxy no es una IP. Es válida para `inet`.
 */
export const UNKNOWN_CLIENT_IP = '0.0.0.0'

/** ¿Una IP que la columna `inet` guarda? IPv4 o IPv6, sin zona (`fe80::1%eth0`, que inet rechaza). */
function isInetAddress(value: string): boolean {
  return isIP(value) !== 0 && !value.includes('%')
}

/**
 * IP real del cliente, siempre válida para `inet`. Con Cloudflare delante y el origen aceptando solo
 * sus rangos, `CF-Connecting-IP` es fiable y se usa si trae una IP válida. Si no, `req.ip`, que
 * Express deriva de `trust proxy` (nunca `true`: ver `TRUST_PROXY`). Detrás de un proxy de confianza,
 * Express toma de `X-Forwarded-For` lo que venga sin validarlo: si no es una IP, la del cliente no se
 * conoce y se usa `UNKNOWN_CLIENT_IP` (no la del proxy, que no es la del cliente). La usan el límite de
 * peticiones, el captcha y el registro de los consentimientos, cuya columna `ip` es `inet`: un texto
 * que no es una IP haría fallar el INSERT de la solicitud en cada reintento.
 */
export function resolveClientIp(req: Request, trustCloudflareHeaders: boolean): string {
  if (trustCloudflareHeaders) {
    const cloudflareIp = cloudflareClientIp(req)
    if (cloudflareIp !== undefined) return cloudflareIp
  }
  const ip = req.ip ?? req.socket.remoteAddress
  return ip !== undefined && isInetAddress(ip) ? ip : UNKNOWN_CLIENT_IP
}

/** La IP de `CF-Connecting-IP`, si trae una válida para `inet`. */
function cloudflareClientIp(req: Request): string | undefined {
  const cloudflareIp = req.get(CLOUDFLARE_CLIENT_IP_HEADER)?.trim()
  return cloudflareIp !== undefined && isInetAddress(cloudflareIp) ? cloudflareIp : undefined
}

/**
 * Señales de que `TRUST_PROXY` o `TRUST_CLOUDFLARE_HEADERS` no coinciden con lo que hay delante de la
 * API. Con cualquiera de ellas, muchos visitantes comparten una IP: un solo cupo del límite de envíos
 * y la IP del proxy o del borde de Cloudflare en los consentimientos.
 * - `cloudflare-header-ignored`: Cloudflare informa la IP del visitante y la API usa otra.
 * - `forwarded-for-untrusted`: llega `X-Forwarded-For` y Express la ignoró, porque la conexión no es
 *   de un proxy que `TRUST_PROXY` reconozca: la IP usada es la del proxy.
 * - `cloudflare-header-missing`: se confía en Cloudflare, pero llega una petición por un proxy sin
 *   `CF-Connecting-IP` válida: Cloudflare no está delante o el proxy quita la cabecera.
 */
export type ClientIpMisconfiguration =
  | 'cloudflare-header-ignored'
  | 'forwarded-for-untrusted'
  | 'cloudflare-header-missing'

/** El problema de configuración que delata esta petición, o `null` si no delata ninguno. */
export function diagnoseClientIp(
  req: Request,
  trustCloudflareHeaders: boolean,
): ClientIpMisconfiguration | null {
  const cloudflareIp = cloudflareClientIp(req)
  const forwarded = (req.get(FORWARDED_FOR_HEADER) ?? '').trim() !== ''
  if (trustCloudflareHeaders) {
    return cloudflareIp === undefined && forwarded ? 'cloudflare-header-missing' : null
  }
  if (cloudflareIp !== undefined && resolveClientIp(req, false) !== cloudflareIp) {
    return 'cloudflare-header-ignored'
  }
  return forwarded && req.ip === req.socket.remoteAddress ? 'forwarded-for-untrusted' : null
}
