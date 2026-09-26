// Frontera del módulo para las demás capas (persistencia de infrastructure y raíz de composición).
// AdvanceRequestsModule no se exporta aquí: AppModule lo importa de su archivo, y así no se forma el
// ciclo advance-requests.module → advance-requests-persistence.module → este index.
export { SupplierConfirmationEmailHandler } from './application/handlers/supplier-confirmation-email.handler.js'
export {
  TeamAlertEmailHandler,
  type TeamAlertEmailOptions,
} from './application/handlers/team-alert-email.handler.js'
export {
  ADVANCE_REQUEST_NOTIFICATION_READER,
  type AdvanceRequestNotificationReaderPort,
  type AdvanceRequestNotificationView,
} from './application/ports/advance-request-notification-reader.port.js'
export {
  ADVANCE_REQUEST_REPOSITORY,
  type AdvanceRequestRepositoryPort,
  type CreateAdvanceRequestResult,
  type ReservedFile,
} from './application/ports/advance-request-repository.port.js'
export {
  LEGAL_DOCUMENT_READER,
  type LegalDocumentReaderPort,
} from './application/ports/legal-document-reader.port.js'
export {
  PAYER_CONDITIONS_READER,
  type PayerConditionsReaderPort,
} from './application/ports/payer-conditions-reader.port.js'
export {
  ADVANCE_REQUEST_OUTBOX_HANDLERS,
  type AdvanceRequestOutboxHandler,
} from './domain/services/outbox-handlers.js'
export type {
  ConsentType,
  NewAdvanceRequest,
  NewConsent,
  NewInvoice,
  NewInvoiceInstallment,
} from './domain/types/new-advance-request.js'
export type { PayerConditions } from './domain/types/payer-conditions.js'
