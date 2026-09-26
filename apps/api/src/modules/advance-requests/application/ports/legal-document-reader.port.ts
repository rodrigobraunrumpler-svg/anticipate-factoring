import type { ConsentType } from '#/modules/advance-requests/domain/types/new-advance-request.js'

export interface LegalDocumentReaderPort {
  /**
   * true si la versión existe en `legal_document_versions` y no está retirada; false en cualquier
   * otro caso, también si `version` es un texto que la columna no puede guardar (U+0000, un
   * sustituto suelto). Nunca rechaza por el texto de la versión: solo si la base no responde.
   */
  isCurrent(type: ConsentType, version: string): Promise<boolean>
}

export const LEGAL_DOCUMENT_READER = Symbol('LEGAL_DOCUMENT_READER')
