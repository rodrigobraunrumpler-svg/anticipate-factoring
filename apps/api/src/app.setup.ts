import { type NestApplicationOptions, RequestMethod, VersioningType } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import helmet from 'helmet'
import { Logger } from 'nestjs-pino'
import {
  API_DEFAULT_VERSION,
  API_PREFIX,
  configureBodyParsers,
  configureServerTimeouts,
  createCorsOptions,
  createHelmetOptions,
  HEALTH_PATHS,
  setupSwagger,
} from '#/bootstrap/index.js'
import type { AppConfig } from '#/common/config/index.js'
import { CorrelationIdMiddleware } from '#/common/middleware/index.js'

/**
 * Opciones de creación que comparten `main.ts` y `createTestApp`. `bodyParser: false` porque los
 * parsers los registra `configureBodyParsers`; `abortOnError: false` para que un fallo al arrancar
 * llegue como excepción y no como `process.exit`.
 */
export const NEST_APP_OPTIONS = {
  bufferLogs: true,
  abortOnError: false,
  bodyParser: false,
} as const satisfies NestApplicationOptions

/**
 * Contrato HTTP compartido por producción y tests: logger, proxies de confianza, id de correlación,
 * helmet, CORS, parser de JSON, prefijo `api` (sin las sondas), versión en la URI, tiempos del servidor
 * y Swagger fuera de producción. No crea la app ni abre el puerto: eso lo hace `main.ts`.
 */
export function setupApp(app: NestExpressApplication, config: AppConfig): NestExpressApplication {
  app.useLogger(app.get(Logger))
  app.set('trust proxy', config.trustProxy)
  app.set('query parser', 'simple')
  const correlationId = new CorrelationIdMiddleware()
  app.use(correlationId.use.bind(correlationId))
  app.use(helmet(createHelmetOptions(config.nodeEnv)))
  app.enableCors(createCorsOptions(config.corsOrigins))
  configureBodyParsers(app)
  app.setGlobalPrefix(API_PREFIX, {
    exclude: Object.values(HEALTH_PATHS).map((path) => ({ path, method: RequestMethod.GET })),
  })
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: API_DEFAULT_VERSION })
  configureServerTimeouts(app.getHttpServer(), config.server)
  if (config.nodeEnv !== 'production') setupSwagger(app)
  return app
}
