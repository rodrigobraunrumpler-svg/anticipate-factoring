import { Module } from '@nestjs/common'
import { TerminusModule } from '@nestjs/terminus'
import { MaintenancePersistenceModule } from '#/infrastructure/prisma/repositories/maintenance/maintenance-persistence.module.js'
import { HealthController } from './controllers/health.controller.js'

@Module({
  imports: [TerminusModule, MaintenancePersistenceModule],
  controllers: [HealthController],
})
export class HealthChecksModule {}
