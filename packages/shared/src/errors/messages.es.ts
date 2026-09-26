import type { ProblemCode } from './codes.js'

/** Mensajes para el usuario final. Los marcadores `{nombre}` se reemplazan con `data`. */
export const MESSAGES_ES: Readonly<Record<ProblemCode, string>> = {
  INVALID_RUC: 'El RUC no es válido.',
  INVALID_DNI: 'El DNI debe tener 8 dígitos.',
  UNREADABLE_XML: 'No pudimos leer el archivo XML. Verifica que sea el XML original de la factura.',
  XML_TOO_LARGE: 'El archivo XML supera el tamaño máximo permitido.',
  XML_DOCTYPE_NOT_ALLOWED:
    'El archivo XML contiene una declaración DOCTYPE, que no está permitida.',
  XML_NOT_AN_INVOICE: 'El archivo no es una factura electrónica ({kind}).',
  XML_MISSING_REQUIRED_FIELD: 'El XML no contiene el dato "{field}".',
  XML_INVALID_FIELD: 'El dato "{field}" del XML no tiene un formato válido.',
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
  ISSUE_DATE_IN_FUTURE: 'La factura {invoice} tiene fecha de emisión futura.',
  ISSUE_DATE_AFTER_DUE_DATE: 'La factura {invoice} vence antes de su fecha de emisión.',
  INSTALLMENT_AMOUNT_ZERO: 'La cuota {installment} de la factura {invoice} tiene monto cero.',
  NET_PENDING_EXCEEDS_TOTAL: 'El neto pendiente de la factura {invoice} supera su total.',
  NO_INVOICES: 'Adjunta al menos una factura.',
  TOO_MANY_INVOICES: 'Puedes enviar como máximo {max} facturas por solicitud.',
  MIXED_ISSUERS: 'Todas las facturas deben ser de la misma empresa emisora.',
  MIXED_CURRENCIES: 'Todas las facturas de una solicitud deben estar en la misma moneda.',
  DUPLICATE_INVOICE: 'La factura {invoice} está repetida en esta solicitud.',
  TOTAL_OUT_OF_RANGE: 'La suma de las facturas supera el monto máximo que podemos procesar.',
  INVALID_AMOUNT: 'El monto debe ser un número mayor que cero con dos decimales.',
  AMOUNT_EXCEEDS_MAXIMUM: 'El monto solicitado supera el máximo de {max} {currency}.',
  NO_MAXIMUM_AVAILABLE: 'No podemos calcular el monto máximo porque las facturas tienen problemas.',
  TRANSITION_NOT_ALLOWED: 'Este cambio de estado no está permitido desde el estado actual.',
  INSUFFICIENT_ROLE: 'Tu rol no permite hacer este cambio de estado.',
  CLOSE_REASON_REQUIRED: 'Indica el motivo del cierre.',
  CLOSE_REASON_NOT_VALID: 'El motivo elegido no corresponde a este cierre.',
  CLOSE_REASON_NOT_APPLICABLE: 'Solo el rechazo y el desistimiento llevan motivo de cierre.',
  CLOSE_REASON_DETAIL_REQUIRED: 'Describe el motivo cuando eliges «Otro motivo».',
  PAYER_NOT_AVAILABLE: 'El programa de adelanto «{payer}» no está disponible.',
  FILE_TOO_LARGE: 'El archivo {file} supera el máximo de {max} MB.',
  INVALID_PDF: 'El archivo {file} no es un PDF válido.',
  PDF_WITHOUT_XML: 'El PDF {file} no corresponde a ninguna factura XML adjunta.',
  DUPLICATE_FILE_NAME:
    'El archivo {file} tiene el mismo nombre que otro XML adjunto (sin contar mayúsculas ni extensión). Cambia el nombre de uno de ellos, y el de su PDF si lo adjuntas, para que cada factura tenga un nombre distinto.',
  INVALID_FILE_NAME:
    'El archivo «{file}» tiene un nombre que no podemos usar: debe tener hasta {max} caracteres y ningún carácter de control. Cámbiale el nombre y vuelve a adjuntarlo.',
  INVOICE_ALREADY_IN_OPEN_REQUEST: 'La factura {invoice} ya está en otra solicitud en curso.',
  CONSENT_VERSION_OUTDATED:
    'Los términos o la política de privacidad cambiaron. Recarga la página y acéptalos de nuevo.',
}
