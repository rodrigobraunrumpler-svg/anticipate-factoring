import type { IsoDate } from '@anticipate/shared/dates'
import type { Problem } from '@anticipate/shared/errors'
import type { ParsedInvoice } from '@anticipate/shared/invoice'
import type { Amount, Currency } from '@anticipate/shared/money'
import type { PayerConditions } from './payer-conditions.js'

/** Lo que el dominio usa de un archivo subido. Un archivo de multer en memoria lo cumple tal cual. */
export type UploadedFile = { originalname: string; buffer: Buffer; size: number }

/** Una factura aceptada: lo leído de su XML, su clave canónica y sus archivos. */
export type IntakeInvoice = {
  invoice: ParsedInvoice
  /** `invoiceKey(invoice)` de shared: la identidad del índice `invoices_open_invoice_key_key`. */
  key: string
  xml: UploadedFile
  pdf: UploadedFile | null
}

export type InvoiceIntakeResult =
  | {
      ok: true
      /** En el orden en que llegaron los XML. */
      invoices: IntakeInvoice[]
      currency: Currency
      totalNetPending: Amount
      maxAmount: Amount
    }
  | { ok: false; problems: Problem[] }

/** Topes por archivo, de la configuración `upload`. */
export type InvoiceIntakeLimits = { maxXmlBytes: number; maxPdfBytes: number }

export type InvoiceIntakeInput = {
  payer: PayerConditions
  /** RUC que el proveedor declaró en el formulario. */
  supplierRuc: string
  /** "Hoy" en Lima (`todayIn(LIMA_TIME_ZONE, clock.now())`), calculado una vez por solicitud. */
  today: IsoDate
  requestedAmount: Amount
  xmlFiles: readonly UploadedFile[]
  pdfFiles: readonly UploadedFile[]
}
