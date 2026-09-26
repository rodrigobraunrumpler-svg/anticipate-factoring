import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common'
import { APP_CONFIG, type AppConfig } from '#/common/config/index.js'
import { ContentLengthLimitMiddleware } from '#/common/middleware/content-length-limit.middleware.js'
import { FILE_STORAGE, type FileStoragePort } from '#/common/storage/index.js'
import { CLOCK, type Clock } from '#/common/time/clock.js'
import { TurnstileModule } from '#/infrastructure/captcha/turnstile/index.js'
import { InvoiceXmlParserModule } from '#/infrastructure/invoice-xml/worker-threads/index.js'
import { newId } from '#/infrastructure/prisma/id.js'
import { AdvanceRequestsPersistenceModule } from '#/infrastructure/prisma/repositories/advance-requests/advance-requests-persistence.module.js'
import { SupplierConfirmationEmailHandler } from '#/modules/advance-requests/application/handlers/supplier-confirmation-email.handler.js'
import { TeamAlertEmailHandler } from '#/modules/advance-requests/application/handlers/team-alert-email.handler.js'
import {
  ADVANCE_REQUEST_NOTIFICATION_READER,
  type AdvanceRequestNotificationReaderPort,
} from '#/modules/advance-requests/application/ports/advance-request-notification-reader.port.js'
import {
  ADVANCE_REQUEST_REPOSITORY,
  type AdvanceRequestRepositoryPort,
} from '#/modules/advance-requests/application/ports/advance-request-repository.port.js'
import {
  INVOICE_XML_PARSER,
  type InvoiceXmlParserPort,
} from '#/modules/advance-requests/application/ports/invoice-xml-parser.port.js'
import {
  LEGAL_DOCUMENT_READER,
  type LegalDocumentReaderPort,
} from '#/modules/advance-requests/application/ports/legal-document-reader.port.js'
import {
  PAYER_CONDITIONS_READER,
  type PayerConditionsReaderPort,
} from '#/modules/advance-requests/application/ports/payer-conditions-reader.port.js'
import { InvoiceIntakeService } from '#/modules/advance-requests/application/services/invoice-intake.service.js'
import { CreateAdvanceRequestUseCase } from '#/modules/advance-requests/application/use-cases/create-advance-request.use-case.js'
import { AdvanceRequestsController } from '#/modules/advance-requests/presentation/http/controllers/advance-requests.controller.js'
import { IntakeLimitsController } from '#/modules/advance-requests/presentation/http/controllers/intake-limits.controller.js'
import { EMAIL_SENDER, type EmailSenderPort } from '#/modules/notifications/index.js'
import { OUTBOX_WAKE_UP, type OutboxWakeUpSignal } from '#/modules/outbox/index.js'

/**
 * Solicitudes de adelanto: `POST /api/v1/advance-requests`, `GET /api/v1/intake-limits` (los topes
 * de subida para la landing) y los dos handlers de correo del outbox, que exporta para que
 * `OutboxPublisherModule` los registre. Los casos de uso y handlers son
 * clases sin Nest: se cablean aquí con `useFactory`. `FILE_STORAGE`, `OUTBOX_WAKE_UP`,
 * `EMAIL_SENDER`, `CLOCK` y `APP_CONFIG` llegan de módulos globales; el lector de XML
 * (`INVOICE_XML_PARSER`), de `InvoiceXmlParserModule`.
 */
@Module({
  imports: [AdvanceRequestsPersistenceModule, TurnstileModule, InvoiceXmlParserModule],
  controllers: [AdvanceRequestsController, IntakeLimitsController],
  providers: [
    {
      provide: InvoiceIntakeService,
      inject: [APP_CONFIG, INVOICE_XML_PARSER],
      useFactory: ({ upload }: AppConfig, xmlParser: InvoiceXmlParserPort) =>
        new InvoiceIntakeService(
          { maxXmlBytes: upload.maxXmlBytes, maxPdfBytes: upload.maxPdfBytes },
          xmlParser,
        ),
    },
    {
      provide: CreateAdvanceRequestUseCase,
      inject: [
        ADVANCE_REQUEST_REPOSITORY,
        PAYER_CONDITIONS_READER,
        LEGAL_DOCUMENT_READER,
        InvoiceIntakeService,
        FILE_STORAGE,
        OUTBOX_WAKE_UP,
        CLOCK,
        APP_CONFIG,
      ],
      useFactory: (
        repository: AdvanceRequestRepositoryPort,
        payerConditions: PayerConditionsReaderPort,
        legalDocuments: LegalDocumentReaderPort,
        invoiceIntake: InvoiceIntakeService,
        storage: FileStoragePort,
        outboxWakeUp: OutboxWakeUpSignal,
        clock: Clock,
        config: AppConfig,
      ) =>
        new CreateAdvanceRequestUseCase({
          repository,
          payerConditions,
          legalDocuments,
          invoiceIntake,
          storage,
          outboxWakeUp,
          clock,
          newId,
          publicCodePrefix: config.publicCodePrefix,
          submissionTimeoutMs: config.submission.timeoutMs,
          cleanupTimeoutMs: config.submission.cleanupTimeoutMs,
        }),
    },
    {
      provide: SupplierConfirmationEmailHandler,
      inject: [ADVANCE_REQUEST_NOTIFICATION_READER, EMAIL_SENDER],
      useFactory: (notifications: AdvanceRequestNotificationReaderPort, sender: EmailSenderPort) =>
        new SupplierConfirmationEmailHandler(notifications, sender),
    },
    {
      provide: TeamAlertEmailHandler,
      inject: [ADVANCE_REQUEST_NOTIFICATION_READER, EMAIL_SENDER, APP_CONFIG],
      useFactory: (
        notifications: AdvanceRequestNotificationReaderPort,
        sender: EmailSenderPort,
        config: AppConfig,
      ) =>
        new TeamAlertEmailHandler(notifications, sender, {
          teamNotificationEmail: config.teamNotificationEmail,
          adminBaseUrl: config.adminBaseUrl,
        }),
    },
  ],
  exports: [SupplierConfirmationEmailHandler, TeamAlertEmailHandler],
})
export class AdvanceRequestsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Con la clase y no con el path: con prefijo y versión, el texto dejaría de coincidir sin avisar.
    // Solo el envío: `GET /api/v1/intake-limits` no tiene cuerpo.
    consumer.apply(ContentLengthLimitMiddleware).forRoutes(AdvanceRequestsController)
  }
}
