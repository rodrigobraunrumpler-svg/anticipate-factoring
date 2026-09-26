import { createProblem, type Problem } from '@anticipate/shared/errors'
import type { ParsedInvoice, ParseResult } from '@anticipate/shared/invoice'
import type { UploadedFile } from '../types/invoice-intake.types.js'

export type ReadInvoice<T extends UploadedFile> = { file: T; invoice: ParsedInvoice }

export type XmlFileReading<T extends UploadedFile> =
  | { ok: true; read: ReadInvoice<T> }
  | { ok: false; problem: Problem }

/**
 * Un XML mayor al tope es `XML_TOO_LARGE` con su nombre, sin leer su contenido (ni `buffer`); `null`
 * si entra. El nombre ya pasó `screenFileNames` (lo hace `InvoiceIntakeService`), así que el problema
 * repite un nombre acotado.
 */
export function oversizedXmlProblem(file: UploadedFile, maxXmlBytes: number): Problem | null {
  return file.size > maxXmlBytes
    ? createProblem('XML_TOO_LARGE', { file: file.originalname })
    : null
}

/**
 * Lo que devolvió el lector de shared para `file`: la factura leída junto a su archivo, o el problema
 * con el archivo que lo causó en `file`. El `field` del lector (el dato de la factura que falta o es
 * inválido) se conserva.
 */
export function toXmlFileReading<T extends UploadedFile>(
  file: T,
  result: ParseResult,
): XmlFileReading<T> {
  return result.ok
    ? { ok: true, read: { file, invoice: result.invoice } }
    : { ok: false, problem: { ...result.problem, file: file.originalname } }
}

/**
 * Un XML que el lector no pudo terminar dentro de sus topes de tiempo o de memoria es ilegible para el
 * proveedor: `UNREADABLE_XML` con su nombre («verifica que sea el XML original de la factura»).
 * Ningún XML emitido para SUNAT se acerca a esos topes.
 */
export function unreadableXmlProblem(file: UploadedFile): Problem {
  return createProblem('UNREADABLE_XML', { file: file.originalname })
}
