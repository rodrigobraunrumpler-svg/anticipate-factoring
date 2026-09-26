import { type DynamicModule, Module, type Type } from '@nestjs/common'
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core'
import { ThrottlerModule } from '@nestjs/throttler'
import { LoggerModule } from 'nestjs-pino'
import { createPinoHttpOptions } from '#/bootstrap/index.js'
import { type AppConfig, AppConfigModule } from '#/common/config/index.js'
import {
  AllExceptionsFilter,
  EXCEPTION_TRANSLATORS,
  type ExceptionTranslator,
} from '#/common/filters/index.js'
import { AppThrottlerGuard, createThrottlerOptions } from '#/common/guards/app-throttler.guard.js'
import { InflightBodyBudgetModule } from '#/common/interceptors/inflight-body-budget.module.js'
import { ResponseEnvelopeInterceptor } from '#/common/interceptors/response-envelope.interceptor.js'
import { NotificationsInfrastructureModule } from '#/infrastructure/notifications/index.js'
import { PrismaModule, translateDatabaseException } from '#/infrastructure/prisma/index.js'
import { StorageModule } from '#/infrastructure/storage/s3/index.js'
import { TimeModule } from '#/infrastructure/time/index.js'
import { AdvanceRequestsModule } from '#/modules/advance-requests/advance-requests.module.js'
import {
  ADVANCE_REQUEST_OUTBOX_HANDLERS,
  SupplierConfirmationEmailHandler,
  TeamAlertEmailHandler,
} from '#/modules/advance-requests/index.js'
import { HealthChecksModule } from '#/modules/health-checks/index.js'
import { OutboxModule } from '#/modules/outbox/index.js'
import { PayersModule } from '#/modules/payers/payers.module.js'
import { MaintenanceWorkerModule } from '#/workers/maintenance/maintenance-worker.module.js'
import { OutboxPublisherModule } from '#/workers/outbox-publisher/outbox-publisher.module.js'

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
        InflightBodyBudgetModule,
        TimeModule,
        PrismaModule,
        StorageModule,
        HealthChecksModule,
        PayersModule,
        NotificationsInfrastructureModule,
        OutboxModule,
        AdvanceRequestsModule,
        OutboxPublisherModule.forRoot({
          imports: [AdvanceRequestsModule],
          handlers: [SupplierConfirmationEmailHandler, TeamAlertEmailHandler],
          requiredHandlers: Object.values(ADVANCE_REQUEST_OUTBOX_HANDLERS),
        }),
        MaintenanceWorkerModule,
        ...extraModules,
      ],
      providers: [
        { provide: APP_GUARD, useClass: AppThrottlerGuard },
        // Errores de infraestructura que el filtro traduce: la base caída es 503 en toda ruta.
        {
          provide: EXCEPTION_TRANSLATORS,
          useValue: [translateDatabaseException] satisfies readonly ExceptionTranslator[],
        },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
      ],
    }
  }
}
