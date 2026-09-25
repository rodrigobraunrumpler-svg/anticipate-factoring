import type { HelmetOptions } from 'helmet'
import type { NodeEnvironment } from '#/common/config/index.js'

/**
 * Cabeceras de seguridad. En producción, todos los valores por defecto de helmet. Fuera de producción
 * se apagan la CSP (Swagger UI en `/docs` carga scripts y estilos que la CSP por defecto bloquea) y
 * HSTS (en local se sirve por http).
 */
export function createHelmetOptions(nodeEnv: NodeEnvironment): HelmetOptions {
  if (nodeEnv === 'production') return {}
  return { contentSecurityPolicy: false, strictTransportSecurity: false }
}
