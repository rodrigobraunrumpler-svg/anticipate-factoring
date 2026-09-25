import { type DynamicModule, Module, type Type } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { ThrottlerModule } from '@nestjs/throttler'
import { LoggerModule } from 'nestjs-pino'
import { createPinoHttpOptions } from '#/bootstrap/index.js'
import { type AppConfig, AppConfigModule } from '#/common/config/index.js'
import { AppThrottlerGuard, createThrottlerOptions } from '#/common/guards/app-throttler.guard.js'
import { TimeModule } from '#/infrastructure/time/index.js'
import { HealthChecksModule } from '#/modules/health-checks/index.js'

/** Módulos que un test agrega a la app (controladores de prueba, raíces de composición). */
export type ExtraModules = ReadonlyArray<Type | DynamicModule>

/**
 * Raíz de composición de la API. Recibe la configuración ya validada: `main.ts` la arma con
 * `parseConfig(process.env)` y los tests con `testConfig()`. Cada tarea que agrega un módulo lo
 * registra aquí.
 */
@Module({})
export class AppModule {
  static register(config: AppConfig, extraModules: ExtraModules = []): DynamicModule {
    return {
      module: AppModule,
      imports: [
        AppConfigModule.register(config),
        LoggerModule.forRoot(createPinoHttpOptions(config)),
        ThrottlerModule.forRoot(createThrottlerOptions(config.throttle)),
        TimeModule,
        HealthChecksModule,
        ...extraModules,
      ],
      providers: [{ provide: APP_GUARD, useClass: AppThrottlerGuard }],
    }
  }
}
