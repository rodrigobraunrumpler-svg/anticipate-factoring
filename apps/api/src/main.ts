import { Logger } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { GracefulShutdown, HttpServerDrain, startupBannerLines } from '#/bootstrap/index.js'
import { ConfigValidationError, parseConfig } from '#/common/config/index.js'
import { AppModule } from './app.module.js'
import { NEST_APP_OPTIONS, setupApp } from './app.setup.js'

/** Fuera de producción lee `apps/api/.env` si existe; en producción las variables vienen del entorno. */
function loadDotEnvFile(): void {
  if (process.env.NODE_ENV === 'production') return
  try {
    process.loadEnvFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function bootstrap(): Promise<void> {
  loadDotEnvFile()
  const config = parseConfig(process.env)
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register(config),
    NEST_APP_OPTIONS,
  )
  try {
    setupApp(app, config)
    // Antes de abrir el puerto: sigue cada conexión y cada petición desde la primera.
    const drain = new HttpServerDrain(app.getHttpServer())
    await app.listen(config.port)
    // En lugar de `enableShutdownHooks`: con SIGTERM o SIGINT el servidor drena mientras Nest cierra
    // la app, con el plazo SHUTDOWN_TIMEOUT_MS (D56).
    new GracefulShutdown(drain, {
      timeoutMs: config.shutdown.timeoutMs,
      closeApp: () => app.close(),
      exit: (code) => process.exit(code),
    }).listen(['SIGTERM', 'SIGINT'])
  } catch (error) {
    await app.close()
    throw error
  }
  const logger = new Logger('Bootstrap')
  for (const line of startupBannerLines(config)) logger.log(line)
}

bootstrap().catch((error: unknown) => {
  Logger.flush()
  // Una configuración inválida se explica sola (lista cada variable, sin valores): sin pila.
  console.error(error instanceof ConfigValidationError ? error.message : error)
  process.exitCode = 1
})
