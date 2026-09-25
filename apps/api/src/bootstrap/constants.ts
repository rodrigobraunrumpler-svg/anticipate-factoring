/**
 * Identidad de la API: forma parte del contrato público y cambia solo por revisión de código, nunca
 * por entorno. Lo que sí varía por entorno vive en la configuración validada (`common/config`).
 */
export const API_PREFIX = 'api'
export const API_DEFAULT_VERSION = '1'
export const SWAGGER_PATH = 'docs'

/** Rutas de las sondas: fuera del prefijo `api`, sin versión y sin sobre de respuesta. */
export const HEALTH_PATHS = {
  liveness: 'health',
  readiness: 'health/readiness',
} as const
