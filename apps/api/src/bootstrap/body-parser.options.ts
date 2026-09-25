import type { NestExpressApplication } from '@nestjs/platform-express'

/**
 * Tope del cuerpo JSON. En este paso ninguna ruta recibe JSON: el envío de solicitudes es multipart y
 * tiene su propio tope por `Content-Length`. El parser queda para las rutas del admin.
 */
export const JSON_BODY_LIMIT = '256kb'

/**
 * Registra solo el parser de JSON: la API no acepta formularios `urlencoded`. Requiere crear la app
 * con `bodyParser: false` (`NEST_APP_OPTIONS`).
 */
export function configureBodyParsers(app: NestExpressApplication): void {
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT })
}
