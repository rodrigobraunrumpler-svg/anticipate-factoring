import { isIP } from 'node:net'
import type { Request } from 'express'

/** Cabecera con la IP del visitante que agrega Cloudflare delante del origen. */
const CLOUDFLARE_CLIENT_IP_HEADER = 'cf-connecting-ip'

/** IP que se usa si la conexión ya no tiene dirección (socket cerrado). Es válida para `inet`. */
export const UNKNOWN_CLIENT_IP = '0.0.0.0'

/**
 * IP real del cliente. Con Cloudflare delante y el origen aceptando solo sus rangos,
 * `CF-Connecting-IP` es fiable y se usa si trae una IP válida. Si no, `req.ip`, que Express deriva
 * de `trust proxy` (nunca `true`: ver `TRUST_PROXY`). La usan el límite de peticiones, el captcha y
 * el registro de los consentimientos.
 */
export function resolveClientIp(req: Request, trustCloudflareHeaders: boolean): string {
  if (trustCloudflareHeaders) {
    const cloudflareIp = req.get(CLOUDFLARE_CLIENT_IP_HEADER)?.trim()
    if (cloudflareIp !== undefined && isIP(cloudflareIp) !== 0) return cloudflareIp
  }
  return req.ip ?? req.socket.remoteAddress ?? UNKNOWN_CLIENT_IP
}
