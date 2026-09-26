import type { ConsentType } from '#/modules/advance-requests/domain/types/new-advance-request.js'

export interface LegalDocumentReaderPort {
  /** true si la versión existe en `legal_document_versions` y no está retirada. */
  isCurrent(type: ConsentType, version: string): Promise<boolean>
}

export const LEGAL_DOCUMENT_READER = Symbol('LEGAL_DOCUMENT_READER')
