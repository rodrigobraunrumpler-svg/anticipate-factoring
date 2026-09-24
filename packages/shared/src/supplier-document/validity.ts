import { z } from 'zod'
import { addDaysIso, daysBetween, type IsoDate, isIsoDate } from '../dates/index.js'
import { VALIDATION_MESSAGES_ES } from '../errors/index.js'

export const SUPPLIER_DOCUMENT_TYPES = [
  'REPRESENTATIVE_ID',
  'POWER_OF_ATTORNEY_CERTIFICATE',
  'MASTER_AGREEMENT',
  'OTHER',
] as const
export type SupplierDocumentType = (typeof SUPPLIER_DOCUMENT_TYPES)[number]
export const supplierDocumentTypeSchema = z.enum(SUPPLIER_DOCUMENT_TYPES, {
  error: VALIDATION_MESSAGES_ES.supplierDocument.type,
})

export const SUPPLIER_DOCUMENT_STATUSES = ['PENDING_REVIEW', 'APPROVED', 'REJECTED'] as const
export type SupplierDocumentStatus = (typeof SUPPLIER_DOCUMENT_STATUSES)[number]
export const supplierDocumentStatusSchema = z.enum(SUPPLIER_DOCUMENT_STATUSES, {
  error: VALIDATION_MESSAGES_ES.supplierDocument.status,
})

/**
 * Estados para mostrar: los guardados más `EXPIRED`, que no se guarda (STACK §9: un documento
 * aprobado cuyo `validUntil` ya pasó se muestra como vencido). Lo calcula `displayStatus`.
 */
export const SUPPLIER_DOCUMENT_DISPLAY_STATUSES = [
  ...SUPPLIER_DOCUMENT_STATUSES,
  'EXPIRED',
] as const
export type SupplierDocumentDisplayStatus = (typeof SUPPLIER_DOCUMENT_DISPLAY_STATUSES)[number]

export const SUPPLIER_DOCUMENT_STATUS_LABELS: Readonly<
  Record<SupplierDocumentDisplayStatus, string>
> = {
  PENDING_REVIEW: 'Pendiente de revisión',
  APPROVED: 'Aprobado',
  REJECTED: 'Rechazado',
  EXPIRED: 'Vencido',
}

export const SUPPLIER_DOCUMENT_TYPE_LABELS: Readonly<Record<SupplierDocumentType, string>> = {
  REPRESENTATIVE_ID: 'DNI del representante legal',
  POWER_OF_ATTORNEY_CERTIFICATE: 'Vigencia de poder (SUNARP)',
  MASTER_AGREEMENT: 'Contrato marco',
  OTHER: 'Otro documento',
}

/** Parámetros de negocio; la API los toma de su configuración. */
export type ValidityRules = { powerOfAttorneyValidityDays: number }

export type ValidityInput = { issuedOn?: IsoDate; expiresOn?: IsoDate }

/** Fecha hasta la que el documento vale, o null si no vence. Lanza si falta el dato que el tipo exige. */
export function computeValidUntil(
  type: SupplierDocumentType,
  input: ValidityInput,
  rules: ValidityRules,
): IsoDate | null {
  switch (type) {
    case 'POWER_OF_ATTORNEY_CERTIFICATE': {
      if (!input.issuedOn || !isIsoDate(input.issuedOn))
        throw new Error('POWER_OF_ATTORNEY_CERTIFICATE requiere issuedOn')
      return addDaysIso(input.issuedOn, rules.powerOfAttorneyValidityDays)
    }
    case 'REPRESENTATIVE_ID': {
      if (!input.expiresOn || !isIsoDate(input.expiresOn))
        throw new Error('REPRESENTATIVE_ID requiere expiresOn')
      return input.expiresOn
    }
    case 'MASTER_AGREEMENT':
    case 'OTHER':
      return null
  }
}

export function requiresValidity(type: SupplierDocumentType): boolean {
  return type === 'POWER_OF_ATTORNEY_CERTIFICATE' || type === 'REPRESENTATIVE_ID'
}

export type DocumentValidity = { status: SupplierDocumentStatus; validUntil: IsoDate | null }

/** Aprobado y con `validUntil` de hoy en adelante (o sin vencimiento). */
export function isCurrentlyValid(doc: DocumentValidity, today: IsoDate): boolean {
  if (doc.status !== 'APPROVED') return false
  if (doc.validUntil === null) return true
  return daysBetween(today, doc.validUntil) >= 0
}

/** Estado para el checklist del admin: `EXPIRED` si está aprobado pero su vigencia ya pasó. */
export function displayStatus(
  doc: DocumentValidity,
  today: IsoDate,
): SupplierDocumentDisplayStatus {
  if (doc.status === 'APPROVED' && !isCurrentlyValid(doc, today)) return 'EXPIRED'
  return doc.status
}
