import type { IsoDate } from '../dates/index.js'
import {
  isCurrentlyValid,
  type SupplierDocumentStatus,
  type SupplierDocumentType,
} from './validity.js'

/** Documento del proveedor tal como lo guarda la API. */
export type SupplierDocumentRecord = {
  type: SupplierDocumentType
  status: SupplierDocumentStatus
  validUntil: IsoDate | null
  /** Representante legal al que pertenece (DNI, vigencia de poder), o null si es de la empresa. */
  representativeId: string | null
}

export type LegalRepresentativeRef = { id: string; active: boolean }

/**
 * Qué documentos exige la guarda. Sin valores por defecto: la API los pasa desde su configuración,
 * igual que el resto de parámetros de negocio.
 */
export type DocumentRequirements = {
  /** Tipos que la empresa debe tener vigentes, al menos uno de cada tipo (p. ej. contrato marco). */
  perSupplier: readonly SupplierDocumentType[]
  /** Tipos que algún representante activo debe tener vigentes, todos a la vez (DNI, vigencia de poder). */
  perRepresentative: readonly SupplierDocumentType[]
}

export type DocumentsValidityInput = {
  documents: readonly SupplierDocumentRecord[]
  representatives: readonly LegalRepresentativeRef[]
  today: IsoDate
  requirements: DocumentRequirements
}

/** Lo que falta para cumplir: `representativeId` null si es de la empresa o si no hay representante activo. */
export type MissingDocument = { type: SupplierDocumentType; representativeId: string | null }

export type DocumentsValidity = { valid: boolean; missing: MissingDocument[] }

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)]

/**
 * Guarda `documentsValid` de la máquina de estados (DOCUMENTS_PENDING → UNDER_REVIEW), como función
 * pura: la API carga documentos y representantes y la llama con la fecha de hoy.
 *
 * Es válida cuando cada tipo de `perSupplier` tiene al menos un documento vigente y al menos un
 * representante activo tiene vigentes todos los tipos de `perRepresentative` (si la lista está vacía,
 * no se exige representante). Vigente es aprobado y no vencido (`isCurrentlyValid`): un documento
 * rechazado o pendiente de revisión no cuenta.
 *
 * `missing` alimenta el checklist del admin: lo que le falta a la empresa y, si ningún representante
 * cumple, lo que le falta al representante activo más cercano a cumplir (el primero en caso de
 * empate), o los tipos por representante con `representativeId: null` si no hay representantes
 * activos.
 */
export function evaluateDocumentsValidity(input: DocumentsValidityInput): DocumentsValidity {
  const current = input.documents.filter((doc) => isCurrentlyValid(doc, input.today))
  const has = (type: SupplierDocumentType, representativeId?: string) =>
    current.some(
      (doc) =>
        doc.type === type &&
        (representativeId === undefined || doc.representativeId === representativeId),
    )

  const missing: MissingDocument[] = unique(input.requirements.perSupplier)
    .filter((type) => !has(type))
    .map((type) => ({ type, representativeId: null }))

  const perRepresentative = unique(input.requirements.perRepresentative)
  if (perRepresentative.length > 0) {
    const gaps = input.representatives
      .filter((representative) => representative.active)
      .map((representative) => ({
        representativeId: representative.id,
        lacking: perRepresentative.filter((type) => !has(type, representative.id)),
      }))
    const closest = gaps.reduce<(typeof gaps)[number] | null>(
      (best, gap) => (best === null || gap.lacking.length < best.lacking.length ? gap : best),
      null,
    )
    if (closest === null) {
      missing.push(...perRepresentative.map((type) => ({ type, representativeId: null })))
    } else {
      missing.push(
        ...closest.lacking.map((type) => ({ type, representativeId: closest.representativeId })),
      )
    }
  }

  return { valid: missing.length === 0, missing }
}

/** `true` si la guarda `documentsValid` se cumple. */
export function documentsValid(input: DocumentsValidityInput): boolean {
  return evaluateDocumentsValidity(input).valid
}
