/** Catálogo 01 de SUNAT: tipo de comprobante. */
export const DOCUMENT_TYPE = {
  INVOICE: '01',
  RECEIPT: '03',
  CREDIT_NOTE: '07',
  DEBIT_NOTE: '08',
} as const
export type DocumentType = (typeof DOCUMENT_TYPE)[keyof typeof DOCUMENT_TYPE]

/** Nombres en español para mensajes al usuario. */
export const DOCUMENT_TYPE_NAMES: Record<string, string> = {
  '01': 'factura',
  '03': 'boleta de venta',
  '07': 'nota de crédito',
  '08': 'nota de débito',
}

export const PAYMENT_TERMS = ['CASH', 'CREDIT'] as const
export type PaymentTerms = (typeof PAYMENT_TERMS)[number]
