import type { ParseResult } from '@anticipate/shared/invoice'

/**
 * Cómo terminó la lectura de un XML:
 * - `parsed`: lo que devolvió el lector de shared (`parseUblInvoice(decodeXml(bytes), { maxLength })`),
 *   tal cual: la factura o el problema.
 * - `too-expensive`: el XML pasó el tope de tiempo o de memoria de una lectura. Ningún XML de SUNAT
 *   llega cerca de esos topes; es un archivo que el proveedor tiene que revisar.
 * - `unavailable`: el lector no aceptó el trabajo (saturado, sin un hilo que pueda arrancar o con la
 *   API apagándose). No dice nada del archivo: la solicitud entera se puede reintentar.
 */
export type InvoiceXmlParseOutcome =
  | { readonly status: 'parsed'; readonly result: ParseResult }
  | { readonly status: 'too-expensive'; readonly reason: 'timeout' | 'memory' }
  | {
      readonly status: 'unavailable'
      readonly reason: 'saturated' | 'start-failed' | 'shutting-down'
    }

/**
 * Lector de los XML de facturas, fuera del hilo que atiende las peticiones: leer un XML hostil de
 * 1 MiB lleva medio segundo o más de CPU y en el hilo principal frenaría a toda la API. Nunca modifica
 * ni se queda con `xml`. Rechaza solo por un defecto (el lector falló de una forma que no debería).
 */
export interface InvoiceXmlParserPort {
  parse(xml: Uint8Array, options: { readonly maxLength: number }): Promise<InvoiceXmlParseOutcome>
}

export const INVOICE_XML_PARSER = Symbol('INVOICE_XML_PARSER')
