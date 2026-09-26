import { Logger } from '@nestjs/common'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { AppConfig } from '#/common/config/index.js'
import { type ClientIpMisconfiguration, diagnoseClientIp } from '#/common/utils/client-ip.js'

/** Qué significa cada problema y qué variable se corrige (docs/STACK.md, sección 12). */
const MISCONFIGURATION_MESSAGES: Readonly<Record<ClientIpMisconfiguration, string>> = {
  'cloudflare-header-ignored':
    'IP del cliente mal configurada: Cloudflare informa la IP del visitante (CF-Connecting-IP) y la API usa otra, la del borde de Cloudflare o la del proxy, que comparten muchos visitantes (un solo cupo del límite de envíos y esa IP en los consentimientos). Si el servidor solo acepta tráfico de Cloudflare, usa TRUST_CLOUDFLARE_HEADERS=true (docs/STACK.md, sección 12). Se avisa una vez por proceso',
  'forwarded-for-untrusted':
    'IP del cliente mal configurada: llega X-Forwarded-For desde una dirección que TRUST_PROXY no reconoce y la API usa la IP del proxy para todos los visitantes (un solo cupo del límite de envíos y esa IP en los consentimientos). Pon en TRUST_PROXY la dirección o la subred del proxy (docs/STACK.md, sección 12). Se avisa una vez por proceso',
  'cloudflare-header-missing':
    'IP del cliente mal configurada: TRUST_CLOUDFLARE_HEADERS=true, pero llega una petición por un proxy sin CF-Connecting-IP. Cloudflare no está delante o el proxy quita la cabecera, y esas peticiones usan la IP de la conexión (docs/STACK.md, sección 12). Se avisa una vez por proceso',
}

export type ClientIpProbeOptions = Pick<AppConfig, 'trustProxy' | 'trustCloudflareHeaders'> & {
  /** Peticiones que no se revisan (las sondas: el monitoreo puede llegar sin pasar por Cloudflare). */
  readonly skip?: (req: Request) => boolean
  readonly logger?: Pick<Logger, 'error'>
}

/**
 * Revisa cada petición contra `TRUST_PROXY` y `TRUST_CLOUDFLARE_HEADERS` (`diagnoseClientIp`) y
 * registra un error la primera vez que aparece cada problema. Es la comprobación que la prueba de
 * humo no puede hacer: solo en el despliegue real hay un proxy y Cloudflare delante. El log no lleva
 * IP ni cabeceras (datos personales), solo el problema y la configuración. Nunca corta la petición.
 */
export function createClientIpProbe(options: ClientIpProbeOptions): RequestHandler {
  const logger = options.logger ?? new Logger('ClientIp')
  const reported = new Set<ClientIpMisconfiguration>()
  const context = {
    trustProxy: options.trustProxy,
    trustCloudflareHeaders: options.trustCloudflareHeaders,
  }
  return (req: Request, _res: Response, next: NextFunction) => {
    if (reported.size < Object.keys(MISCONFIGURATION_MESSAGES).length && !options.skip?.(req)) {
      const problem = diagnoseClientIp(req, options.trustCloudflareHeaders)
      if (problem !== null && !reported.has(problem)) {
        reported.add(problem)
        logger.error({ misconfiguration: problem, ...context }, MISCONFIGURATION_MESSAGES[problem])
      }
    }
    next()
  }
}
