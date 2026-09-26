/** UUID canónico (RFC 9562): versión 1 a 8 y variante `10xx`. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function idSegment(value: string): string {
  if (!UUID.test(value)) throw new RangeError(`Segmento de ruta inválido: ${JSON.stringify(value)}`)
  return value.toLowerCase()
}

const invoiceObject = (payerId: string, requestId: string, invoiceId: string): string =>
  `payers/${idSegment(payerId)}/advance-requests/${idSegment(requestId)}/invoices/${idSegment(invoiceId)}`

/**
 * Rutas de los archivos de una solicitud en el almacenamiento (STACK §10). Siempre ids validados,
 * nunca slugs ni nombres escritos por el usuario: una ruta no puede salir de su prefijo.
 */
export const storageKeys = {
  invoiceXml: (payerId: string, requestId: string, invoiceId: string): string =>
    `${invoiceObject(payerId, requestId, invoiceId)}.xml`,
  invoicePdf: (payerId: string, requestId: string, invoiceId: string): string =>
    `${invoiceObject(payerId, requestId, invoiceId)}.pdf`,
} as const
