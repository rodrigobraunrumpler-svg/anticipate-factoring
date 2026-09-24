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

/**
 * Nombre en español de un tipo de comprobante, para mensajes al usuario. Usa `Object.hasOwn` en vez
 * de indexar directamente: `code` puede venir de un XML no confiable y coincidir con una propiedad
 * heredada de `Object.prototype` (por ejemplo `constructor`).
 */
export function documentTypeName(code: string): string {
  if (!Object.hasOwn(DOCUMENT_TYPE_NAMES, code)) return code
  return DOCUMENT_TYPE_NAMES[code] ?? code
}
