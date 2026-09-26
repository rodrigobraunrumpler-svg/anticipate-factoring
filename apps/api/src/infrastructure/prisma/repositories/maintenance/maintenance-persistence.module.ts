import { Module } from '@nestjs/common'
import { HealthIndicatorService, TerminusModule } from '@nestjs/terminus'
import { APP_CONFIG, type AppConfig } from '#/common/config/index.js'
import { PrismaService } from '#/infrastructure/prisma/prisma.service.js'
import { OutboxPersistenceModule } from '#/infrastructure/prisma/repositories/outbox/outbox-persistence.module.js'
import { STORED_FILE_MAINTENANCE } from '#/modules/maintenance/index.js'
import { OUTBOX_EVENT_REPOSITORY, type OutboxEventRepositoryPort } from '#/modules/outbox/index.js'
import {
  OUTBOX_BACKLOG_CACHE_TTL_MS,
  OUTBOX_BACKLOG_TIMEOUT_MS,
  OutboxBacklogReadinessIndicator,
  outboxLateAfterSeconds,
} from './outbox-backlog-readiness.indicator.js'
import { PrismaStoredFileMaintenanceRepository } from './prisma-stored-file-maintenance.repository.js'

/**
 * Persistencia del mantenimiento: el ciclo de vida de `stored_files` y la lectura del backlog del
 * outbox para la readiness. Lo importan `workers/maintenance` y `modules/health-checks`.
 */
@Module({
  imports: [OutboxPersistenceModule, TerminusModule],
  providers: [
    {
      provide: STORED_FILE_MAINTENANCE,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => new PrismaStoredFileMaintenanceRepository(prisma),
    },
    {
      provide: OutboxBacklogReadinessIndicator,
      inject: [OUTBOX_EVENT_REPOSITORY, HealthIndicatorService, APP_CONFIG],
      useFactory: (
        outbox: OutboxEventRepositoryPort,
        indicators: HealthIndicatorService,
        config: AppConfig,
      ) =>
        new OutboxBacklogReadinessIndicator(outbox, indicators, {
          lateAfterSeconds: outboxLateAfterSeconds(config.outbox),
          timeoutMs: OUTBOX_BACKLOG_TIMEOUT_MS,
          cacheTtlMs: OUTBOX_BACKLOG_CACHE_TTL_MS,
        }),
    },
  ],
  exports: [STORED_FILE_MAINTENANCE, OutboxBacklogReadinessIndicator],
})
export class MaintenancePersistenceModule {}
