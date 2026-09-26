import { Module } from '@nestjs/common'
import { APP_CONFIG, type AppConfig } from '#/common/config/index.js'
import { MaintenancePersistenceModule } from '#/infrastructure/prisma/repositories/maintenance/maintenance-persistence.module.js'
import { OutboxPersistenceModule } from '#/infrastructure/prisma/repositories/outbox/outbox-persistence.module.js'
import {
  MaintenanceModule,
  PurgeDeletedFilesUseCase,
  SweepOrphanFilesUseCase,
} from '#/modules/maintenance/index.js'
import {
  OUTBOX_EVENT_REPOSITORY,
  type OutboxEventRepositoryPort,
  PurgePublishedEventsUseCase,
} from '#/modules/outbox/index.js'
import {
  MAINTENANCE_TASKS,
  MaintenanceScheduler,
  type MaintenanceTask,
} from './maintenance.scheduler.js'

/** Nombres de las tareas en el log y en el informe de cada pasada. */
export const MAINTENANCE_TASK_NAMES = {
  purgePublishedEvents: 'outbox.purge-published',
  sweepOrphanFiles: 'storage.sweep-orphans',
  purgeDeletedFiles: 'storage.purge-deleted',
} as const

/**
 * Raíz de composición del mantenimiento: junta la purga del outbox (módulo `outbox`) con el barrido
 * de huérfanos y el borrado diferido (módulo `maintenance`) en una sola pasada. Siempre se carga; el
 * programador decide con MAINTENANCE_ENABLED si corre por su cuenta.
 */
@Module({
  imports: [
    MaintenanceModule.register({ imports: [MaintenancePersistenceModule] }),
    OutboxPersistenceModule,
  ],
  providers: [
    {
      provide: PurgePublishedEventsUseCase,
      inject: [OUTBOX_EVENT_REPOSITORY, APP_CONFIG],
      useFactory: (repository: OutboxEventRepositoryPort, config: AppConfig) =>
        new PurgePublishedEventsUseCase(repository, {
          retentionDays: config.outbox.retentionDays,
          batchSize: config.outbox.purgeBatchSize,
        }),
    },
    {
      provide: MAINTENANCE_TASKS,
      inject: [PurgePublishedEventsUseCase, SweepOrphanFilesUseCase, PurgeDeletedFilesUseCase],
      useFactory: (
        purgePublishedEvents: PurgePublishedEventsUseCase,
        sweepOrphanFiles: SweepOrphanFilesUseCase,
        purgeDeletedFiles: PurgeDeletedFilesUseCase,
      ): MaintenanceTask[] => [
        {
          name: MAINTENANCE_TASK_NAMES.purgePublishedEvents,
          run: () => purgePublishedEvents.execute(),
        },
        // El barrido va antes del borrado diferido: los huérfanos que da de baja salen de S3 en la misma pasada.
        { name: MAINTENANCE_TASK_NAMES.sweepOrphanFiles, run: () => sweepOrphanFiles.execute() },
        { name: MAINTENANCE_TASK_NAMES.purgeDeletedFiles, run: () => purgeDeletedFiles.execute() },
      ],
    },
    {
      provide: MaintenanceScheduler,
      inject: [APP_CONFIG, MAINTENANCE_TASKS],
      useFactory: (config: AppConfig, tasks: readonly MaintenanceTask[]) =>
        new MaintenanceScheduler(
          { enabled: config.maintenance.enabled, intervalMs: config.maintenance.intervalMs },
          tasks,
        ),
    },
  ],
})
export class MaintenanceWorkerModule {}
