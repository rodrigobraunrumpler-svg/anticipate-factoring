import type { ProblemCode } from './codes.js'

/** Mensajes para el usuario final. Los marcadores `{nombre}` se reemplazan con `data`. */
export const MESSAGES_ES: Record<ProblemCode, string> = {
  INVALID_RUC: 'El RUC no es válido.',
  INVALID_DNI: 'El DNI debe tener 8 dígitos.',
  UNREADABLE_XML: 'No pudimos leer el archivo XML. Verifica que sea el XML original de la factura.',
  XML_TOO_LARGE: 'El archivo XML supera el tamaño máximo permitido.',
  XML_DOCTYPE_NOT_ALLOWED:
    'El archivo XML contiene una declaración DOCTYPE, que no está permitida.',
  XML_NOT_AN_INVOICE: 'El archivo no es una factura electrónica ({kind}).',
  XML_MISSING_REQUIRED_FIELD: 'El XML no contiene el dato "{field}".',
  DOCUMENT_TYPE_NOT_ALLOWED:
    'Solo aceptamos facturas electrónicas (tipo 01). Este comprobante es de tipo {kind}.',
  RECIPIENT_IS_NOT_PAYER: 'La factura no está emitida a {payer}.',
  ISSUER_IS_NOT_SUPPLIER:
    'La factura fue emitida por otro RUC ({issuer}), no por el de tu empresa.',
  CASH_INVOICE: 'La factura es al contado; solo podemos adelantar facturas al crédito.',
  NO_PENDING_AMOUNT: 'La factura no declara un monto neto pendiente de pago.',
  CURRENCY_NOT_ALLOWED: 'No trabajamos con la moneda {currency}.',
  INSTALLMENT_OVERDUE: 'La cuota {installment} venció el {date}.',
  INSUFFICIENT_TERM: 'La cuota {installment} vence en menos de {days} días.',
  NO_INVOICES: 'Adjunta al menos una factura.',
  TOO_MANY_INVOICES: 'Puedes enviar como máximo {max} facturas por solicitud.',
  MIXED_ISSUERS: 'Todas las facturas deben ser de la misma empresa emisora.',
  MIXED_CURRENCIES: 'Todas las facturas de una solicitud deben estar en la misma moneda.',
  DUPLICATE_INVOICE: 'La factura {invoice} está repetida en esta solicitud.',
  INVALID_AMOUNT: 'El monto debe ser un número mayor que cero con dos decimales.',
  AMOUNT_EXCEEDS_MAXIMUM: 'El monto solicitado supera el máximo de {max} {currency}.',
}
