import type { NodeEnvironment } from '#/common/config/index.js'
import { API_DEFAULT_VERSION, API_PREFIX, HEALTH_PATHS, SWAGGER_PATH } from './constants.js'

export type StartupBannerInput = { nodeEnv: NodeEnvironment; port: number }

/**
 * Líneas que la API escribe al arrancar. Fuera de producción muestra el entorno y las URL completas
 * (API, Swagger y salud) para abrirlas desde la terminal; en producción solo el puerto y el entorno:
 * la URL pública la define el proxy y Swagger no se monta.
 */
export function startupBannerLines({ nodeEnv, port }: StartupBannerInput): string[] {
  if (nodeEnv === 'production') return [`API escuchando en el puerto ${port} (${nodeEnv})`]
  const baseUrl = `http://localhost:${port}`
  return [
    `Entorno: ${nodeEnv}`,
    `API: ${baseUrl}/${API_PREFIX}/v${API_DEFAULT_VERSION}`,
    `Swagger: ${baseUrl}/${SWAGGER_PATH}`,
    `Salud: ${baseUrl}/${HEALTH_PATHS.liveness}`,
  ]
}
