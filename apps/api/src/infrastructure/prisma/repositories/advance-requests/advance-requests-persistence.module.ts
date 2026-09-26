import { Module } from '@nestjs/common'
import { APP_CONFIG, type AppConfig } from '#/common/config/index.js'
import { PrismaService } from '#/infrastructure/prisma/prisma.service.js'
import {
  ADVANCE_REQUEST_NOTIFICATION_READER,
  ADVANCE_REQUEST_REPOSITORY,
  LEGAL_DOCUMENT_READER,
  PAYER_CONDITIONS_READER,
} from '#/modules/advance-requests/index.js'
import { PrismaAdvanceRequestRepository } from './prisma-advance-request.repository.js'
import { PrismaAdvanceRequestNotificationReader } from './prisma-advance-request-notification.reader.js'
import { PrismaLegalDocumentReader } from './prisma-legal-document.reader.js'
import { PrismaPayerConditionsReader } from './prisma-payer-conditions.reader.js'

/** Liga los puertos de `advance-requests` a Prisma. `PrismaService` llega del `PrismaModule` global. */
@Module({
  providers: [
    {
      provide: ADVANCE_REQUEST_REPOSITORY,
      inject: [PrismaService, APP_CONFIG],
      useFactory: (prisma: PrismaService, config: AppConfig) =>
        new PrismaAdvanceRequestRepository(prisma, {
          transactionTimeoutMs: config.database.transactionTimeoutMs,
          transactionMaxWaitMs: config.database.transactionMaxWaitMs,
          outboxMaxAttempts: config.outbox.maxAttempts,
        }),
    },
    {
      provide: PAYER_CONDITIONS_READER,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => new PrismaPayerConditionsReader(prisma),
    },
    {
      provide: LEGAL_DOCUMENT_READER,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => new PrismaLegalDocumentReader(prisma),
    },
    {
      provide: ADVANCE_REQUEST_NOTIFICATION_READER,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => new PrismaAdvanceRequestNotificationReader(prisma),
    },
  ],
  exports: [
    ADVANCE_REQUEST_REPOSITORY,
    PAYER_CONDITIONS_READER,
    LEGAL_DOCUMENT_READER,
    ADVANCE_REQUEST_NOTIFICATION_READER,
  ],
})
export class AdvanceRequestsPersistenceModule {}
