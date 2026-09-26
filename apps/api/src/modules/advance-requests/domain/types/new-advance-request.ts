import type { CavaliRegistration, ContactTimeSlot } from '@anticipate/shared/advance-request'
import type { IsoDate } from '@anticipate/shared/dates'
import type { Amount, Currency } from '@anticipate/shared/money'

/** Documentos legales que el proveedor acepta (enum `consent_type` de la base). */
export type ConsentType = 'TERMS' | 'PERSONAL_DATA'

export type NewInvoiceInstallment = {
  /** Desde 1, en el orden del XML (`invoice_installments.number`). */
  number: number
  /** Identificador de la cuota en el XML (`Cuota001`). */
  label: string
  amount: Amount
  dueDate: IsoDate
}

export type NewInvoice = {
  id: string
  /** `invoiceKey` de shared; la base comprueba que coincide con el emisor y la serie. */
  invoiceKey: string
  documentType: string
  seriesNumber: string
  issuerRuc: string
  issuerName: string
  recipientRuc: string
  total: Amount
  netPendingAmount: Amount
  issueDate: IsoDate
  /** Vencimiento de la última cuota. */
  dueDate: IsoDate
  detraction: { percent: number; amount: Amount } | null
  signed: boolean
  /** Archivos reservados en `stored_files` antes de subirlos. */
  xmlFileId: string
  pdfFileId: string | null
  installments: readonly NewInvoiceInstallment[]
}

export type NewConsent = {
  type: ConsentType
  documentVersion: string
  ip: string
  userAgent: string | null
  acceptedAt: Date
}

/**
 * Todo lo que el repositorio guarda en una transacción al crear la solicitud. Cada campo ya cumple
 * las CHECK de la base: el caso de uso lo arma solo con datos validados por las reglas de shared,
 * y los opcionales vacíos del formulario llegan como `null` (nunca como texto vacío).
 */
export type NewAdvanceRequest = {
  id: string
  idempotencyKey: string
  /** sha256 hexadecimal en minúsculas (`request-fingerprint.ts`). */
  requestFingerprint: string
  payerId: string
  payerRuc: string
  /** Datos para crear el proveedor si es nuevo (`INSERT ON CONFLICT DO NOTHING` y lectura). */
  supplier: { ruc: string; legalName: string }
  /** Razón social tal como la escribió el proveedor en el formulario. */
  supplierLegalName: string
  contact: {
    fullName: string
    dni: string
    mobile: string
    email: string
    isLegalRepresentative: boolean
    jobTitle: string | null
    contactTimeSlot: ContactTimeSlot
  }
  /** Solo si el contacto es el representante legal. */
  legalRepresentative: { dni: string; fullName: string; jobTitle: string | null } | null
  requestedAmount: Amount
  currency: Currency
  purpose: string | null
  cavaliRegistration: CavaliRegistration
  utm: Readonly<Record<string, string>> | null
  referrer: string | null
  /** Condiciones del pagador y montos con los que se evaluó, fijos para siempre. */
  snapshot: {
    appliedAdvancePercent: number
    appliedMinTermDays: number
    totalNetPending: Amount
    maxAmount: Amount
  }
  correlationId: string | null
  publicCodePrefix: string
  publicCodeYear: number
  /** Archivos reservados que pasan a `ATTACHED` en la misma transacción. */
  fileIds: readonly string[]
  invoices: readonly NewInvoice[]
  consents: readonly NewConsent[]
  createdAt: Date
}
