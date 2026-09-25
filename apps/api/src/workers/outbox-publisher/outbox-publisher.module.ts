import {
  type DynamicModule,
  type InjectionToken,
  Logger,
  Module,
  type ModuleMetadata,
} from '@nestjs/common'
import { APP_CONFIG, type AppConfig } from '#/common/config/index.js'
import { OutboxPersistenceModule } from '#/infrastructure/prisma/repositories/outbox/outbox-persistence.module.js'
import {
  OUTBOX_EVENT_HANDLERS,
  OUTBOX_EVENT_REPOSITORY,
  type OutboxEventHandler,
  type OutboxEventRepositoryPort,
  PublishOutboxEventsUseCase,
  PurgePublishedEventsUseCase,
} from '#/modules/outbox/index.js'
import { OutboxPublisherScheduler } from './outbox-publisher.scheduler.js'

export type OutboxPublisherModuleOptions = {
  /** Módulos que exportan los handlers (la Tarea 12 pasa `AdvanceRequestsModule`). */
  imports: NonNullable<ModuleMetadata['imports']>
  /** Tokens de los handlers: cada uno resuelve a un `OutboxEventHandler`. */
  handlers: readonly InjectionToken[]
  /** Nombres que deben tener handler. Si falta uno, o dos handlers comparten nombre, la API no arranca. */
  requiredHandlers: readonly string[]
}

/**
 * Raíz de composición del publicador: junta los handlers de los módulos dueños con el repositorio y
 * la configuración. Siempre se carga; el scheduler solo corre si `OUTBOX_POLLER_ENABLED`.
 */
@Module({})
export class OutboxPublisherModule {
  static forRoot(options: OutboxPublisherModuleOptions): DynamicModule {
    return {
      module: OutboxPublisherModule,
      imports: [OutboxPersistenceModule, ...options.imports],
      providers: [
        {
          provide: OUTBOX_EVENT_HANDLERS,
          inject: [...options.handlers],
          useFactory: (...handlers: OutboxEventHandler[]) => handlers,
        },
        {
          provide: PublishOutboxEventsUseCase,
          inject: [OUTBOX_EVENT_REPOSITORY, OUTBOX_EVENT_HANDLERS, APP_CONFIG],
          useFactory: (
            repository: OutboxEventRepositoryPort,
            handlers: readonly OutboxEventHandler[],
            config: AppConfig,
          ) =>
            new PublishOutboxEventsUseCase(
              repository,
              handlers,
              {
                leaseSeconds: config.outbox.leaseSeconds,
                batchSize: config.outbox.batchSize,
                handlerTimeoutMs: config.outbox.handlerTimeoutMs,
                baseDelayMs: config.outbox.baseDelayMs,
                maxDelayMs: config.outbox.maxDelayMs,
                requiredHandlers: options.requiredHandlers,
              },
              new Logger(PublishOutboxEventsUseCase.name),
            ),
        },
        {
          provide: PurgePublishedEventsUseCase,
          inject: [OUTBOX_EVENT_REPOSITORY, APP_CONFIG],
          useFactory: (repository: OutboxEventRepositoryPort, config: AppConfig) =>
            new PurgePublishedEventsUseCase(repository, {
              retentionDays: config.outbox.retentionDays,
              batchSize: config.outbox.purgeBatchSize,
            }),
        },
        OutboxPublisherScheduler,
      ],
      exports: [PublishOutboxEventsUseCase, PurgePublishedEventsUseCase],
    }
  }
}
