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
 * Todo lo que el repositorio guarda en una transacción al crear la solicitud. Lo que viene del
 * proveedor llega validado por reglas de shared que son las gemelas de las columnas y de sus CHECK
 * (D49): un dato que las pasa nunca hace fallar el INSERT (un 503 en cada reintento), y uno que no
 * las pasa vuelve como 400 o 422 con su campo.
 * - Textos del formulario (`advanceRequestFormSchema`): recortados, con el largo en puntos de código
 *   dentro del `VARCHAR` y de la CHECK de su columna, y solo con caracteres que PostgreSQL guarda sin
 *   cambios (`isXmlText`: ni U+0000 ni un sustituto suelto, tampoco en `utm`, que es jsonb). Los
 *   opcionales vacíos llegan como `null`, nunca como texto vacío. Lo fija un test `(f)` de
 *   `database-structure.test.ts` contra las columnas reales.
 * - Facturas y cuotas (`InvoiceIntakeService`): el lector y las reglas gemelas de las CHECK de
 *   `invoices` e `invoice_installments`. Toda `IsoDate` va del 0001-01-01 al 9999-12-31, lo que
 *   guarda `date` (PostgreSQL no tiene año 0).
 * - Versiones legales: el caso de uso comprueba antes que existan y estén vigentes
 *   (`LegalDocumentReaderPort`), que es lo que exige la FK de `consents`.
 * - Lo que arma el propio caso de uso (ids, huella, código público, `ip` y `userAgent` de cada
 *   consentimiento, `correlationId`, montos de la foto) es responsabilidad suya, no del proveedor.
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
