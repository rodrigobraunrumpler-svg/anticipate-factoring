import { Global, Module } from '@nestjs/common'
import { TerminusModule } from '@nestjs/terminus'
import { PrismaService } from './prisma.service.js'
import { PrismaReadinessIndicator } from './prisma-readiness.indicator.js'

@Global()
@Module({
  imports: [TerminusModule],
  providers: [PrismaService, PrismaReadinessIndicator],
  exports: [PrismaService, PrismaReadinessIndicator],
})
export class PrismaModule {}
