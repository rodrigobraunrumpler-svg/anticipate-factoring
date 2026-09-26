import { isIP } from 'node:net'
import type { Request } from 'express'

/** Cabecera con la IP del visitante que agrega Cloudflare delante del origen. */
const CLOUDFLARE_CLIENT_IP_HEADER = 'cf-connecting-ip'

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
    const cloudflareIp = req.get(CLOUDFLARE_CLIENT_IP_HEADER)?.trim()
    if (cloudflareIp !== undefined && isInetAddress(cloudflareIp)) return cloudflareIp
  }
  const ip = req.ip ?? req.socket.remoteAddress
  return ip !== undefined && isInetAddress(ip) ? ip : UNKNOWN_CLIENT_IP
}
