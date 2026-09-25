import { Module } from '@nestjs/common'
import { PrismaService } from '#/infrastructure/prisma/prisma.service.js'
import { OUTBOX_EVENT_REPOSITORY } from '#/modules/outbox/index.js'
import { PrismaOutboxEventRepository } from './prisma-outbox-event.repository.js'

@Module({
  providers: [
    {
      provide: OUTBOX_EVENT_REPOSITORY,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => new PrismaOutboxEventRepository(prisma),
    },
  ],
  exports: [OUTBOX_EVENT_REPOSITORY],
})
export class OutboxPersistenceModule {}
