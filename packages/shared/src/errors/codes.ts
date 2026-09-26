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
  'XML_INVALID_FIELD',
  // reglas por factura
  'DOCUMENT_TYPE_NOT_ALLOWED',
  'RECIPIENT_IS_NOT_PAYER',
  'ISSUER_IS_NOT_SUPPLIER',
  'CASH_INVOICE',
  'NO_PENDING_AMOUNT',
  'CURRENCY_NOT_ALLOWED',
  'INSTALLMENT_OVERDUE',
  'INSUFFICIENT_TERM',
  'ISSUE_DATE_IN_FUTURE',
  // reglas por factura gemelas de una restricción CHECK de la base (D49): con ellas un dato
  // inválido del XML es un 422 con su problema, nunca un 503 por la restricción
  'ISSUE_DATE_AFTER_DUE_DATE',
  'INSTALLMENT_AMOUNT_ZERO',
  'NET_PENDING_EXCEEDS_TOTAL',
  // reglas del conjunto
  'NO_INVOICES',
  'TOO_MANY_INVOICES',
  'MIXED_ISSUERS',
  'MIXED_CURRENCIES',
  'DUPLICATE_INVOICE',
  'TOTAL_OUT_OF_RANGE',
  // monto solicitado
  'INVALID_AMOUNT',
  'AMOUNT_EXCEEDS_MAXIMUM',
  'NO_MAXIMUM_AVAILABLE',
  // cambio de estado de una solicitud
  'TRANSITION_NOT_ALLOWED',
  'INSUFFICIENT_ROLE',
  'CLOSE_REASON_REQUIRED',
  'CLOSE_REASON_NOT_VALID',
  'CLOSE_REASON_NOT_APPLICABLE',
  'CLOSE_REASON_DETAIL_REQUIRED',
  // recepción de una solicitud en la API
  'PAYER_NOT_AVAILABLE',
  'FILE_TOO_LARGE',
  'INVALID_PDF',
  'PDF_WITHOUT_XML',
  'DUPLICATE_FILE_NAME',
  'INVOICE_ALREADY_IN_OPEN_REQUEST',
  'CONSENT_VERSION_OUTDATED',
] as const

export type ProblemCode = (typeof PROBLEM_CODES)[number]
