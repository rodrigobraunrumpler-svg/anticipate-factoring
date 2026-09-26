import type { AppConfig, NodeEnvironment } from '#/common/config/index.js'
import { API_DEFAULT_VERSION, API_PREFIX, HEALTH_PATHS, SWAGGER_PATH } from './constants.js'

export type StartupBannerInput = { nodeEnv: NodeEnvironment; port: number } & Pick<
  AppConfig,
  'trustProxy' | 'trustCloudflareHeaders'
>

/** De dónde sale la IP del cliente (límite de envíos, captcha y consentimientos). */
function clientIpSourceLine({
  trustProxy,
  trustCloudflareHeaders,
}: Pick<StartupBannerInput, 'trustProxy' | 'trustCloudflareHeaders'>): string {
  const fromConnection = `la de la conexión o la de X-Forwarded-For si el proxy es de confianza (TRUST_PROXY=${trustProxy})`
  return trustCloudflareHeaders
    ? `IP del cliente: CF-Connecting-IP de Cloudflare; sin ella, ${fromConnection}`
    : `IP del cliente: ${fromConnection}; CF-Connecting-IP no se usa`
}

/**
 * Líneas que la API escribe al arrancar. Fuera de producción muestra el entorno y las URL completas
 * (API, Swagger y salud) para abrirlas desde la terminal; en producción solo el puerto y el entorno:
 * la URL pública la define el proxy y Swagger no se monta. Siempre dice de dónde sale la IP del
 * cliente, para revisar `TRUST_PROXY` y `TRUST_CLOUDFLARE_HEADERS` en el log del despliegue.
 */
export function startupBannerLines(input: StartupBannerInput): string[] {
  const { nodeEnv, port } = input
  if (nodeEnv === 'production') {
    return [`API escuchando en el puerto ${port} (${nodeEnv})`, clientIpSourceLine(input)]
  }
  const baseUrl = `http://localhost:${port}`
  return [
    `Entorno: ${nodeEnv}`,
    `API: ${baseUrl}/${API_PREFIX}/v${API_DEFAULT_VERSION}`,
    `Swagger: ${baseUrl}/${SWAGGER_PATH}`,
    `Salud: ${baseUrl}/${HEALTH_PATHS.liveness}`,
    clientIpSourceLine(input),
  ]
}
