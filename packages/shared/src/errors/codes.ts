/** Códigos estables de problemas de negocio. La API y la landing muestran el mensaje; los tests comparan el código. */
export const PROBLEM_CODES = [
  // identidad
  'INVALID_RUC',
  'INVALID_DNI',
  // lectura del XML
  'UNREADABLE_XML',
  'XML_TOO_LARGE',
  'XML_DOCTYPE_NOT_ALLOWED',
  'XML_NOT_AN_INVOICE',
  'XML_MISSING_REQUIRED_FIELD',
  // reglas por factura
  'DOCUMENT_TYPE_NOT_ALLOWED',
  'RECIPIENT_IS_NOT_PAYER',
  'ISSUER_IS_NOT_SUPPLIER',
  'CASH_INVOICE',
  'NO_PENDING_AMOUNT',
  'CURRENCY_NOT_ALLOWED',
  'INSTALLMENT_OVERDUE',
  'INSUFFICIENT_TERM',
  // reglas del conjunto
  'NO_INVOICES',
  'TOO_MANY_INVOICES',
  'MIXED_ISSUERS',
  'MIXED_CURRENCIES',
  'DUPLICATE_INVOICE',
  // monto solicitado
  'INVALID_AMOUNT',
  'AMOUNT_EXCEEDS_MAXIMUM',
  // cambio de estado de una solicitud
  'TRANSITION_NOT_ALLOWED',
  'INSUFFICIENT_ROLE',
  'CLOSE_REASON_REQUIRED',
  'CLOSE_REASON_NOT_VALID',
  'CLOSE_REASON_NOT_APPLICABLE',
  'CLOSE_REASON_DETAIL_REQUIRED',
] as const

export type ProblemCode = (typeof PROBLEM_CODES)[number]
