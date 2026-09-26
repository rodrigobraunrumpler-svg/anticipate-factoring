import { createProblem, type Problem } from '@anticipate/shared/errors'
import { decodeXml, type ParsedInvoice, parseUblInvoice } from '@anticipate/shared/invoice'
import type { UploadedFile } from '../types/invoice-intake.types.js'

export type ReadInvoice<T extends UploadedFile> = { file: T; invoice: ParsedInvoice }

export type XmlFileReading<T extends UploadedFile> =
  | { ok: true; read: ReadInvoice<T> }
  | { ok: false; problem: Problem }

/**
 * Lee un XML con el lector de shared. El problema lleva en `file` el archivo que lo causó; el
 * `field` del lector (el dato de la factura que falta o es inválido) se conserva. Un XML mayor al
 * tope se rechaza sin leer su contenido.
 *
 * Lee un solo archivo a propósito: es trabajo de CPU sincrónico (un XML de 1 MiB armado para eso
 * lleva cerca de medio segundo), así que quien lee varios decide cuándo ceder el turno entre uno y
 * otro (`InvoiceIntakeService`).
 */
export function readInvoice<T extends UploadedFile>(
  file: T,
  maxXmlBytes: number,
): XmlFileReading<T> {
  if (file.size > maxXmlBytes) {
    return { ok: false, problem: createProblem('XML_TOO_LARGE', { file: file.originalname }) }
  }
  const result = parseUblInvoice(decodeXml(file.buffer), { maxLength: maxXmlBytes })
  return result.ok
    ? { ok: true, read: { file, invoice: result.invoice } }
    : { ok: false, problem: { ...result.problem, file: file.originalname } }
}
