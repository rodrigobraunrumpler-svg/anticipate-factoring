import { createProblem, type Problem } from '@anticipate/shared/errors'
import { decodeXml, type ParsedInvoice, parseUblInvoice } from '@anticipate/shared/invoice'
import type { UploadedFile } from '../types/invoice-intake.types.js'

export type ReadInvoice<T extends UploadedFile> = { file: T; invoice: ParsedInvoice }

export type XmlReading<T extends UploadedFile> = { read: ReadInvoice<T>[]; problems: Problem[] }

/**
 * Lee cada XML con el lector de shared, en el orden recibido. Todo problema lleva en `file` el
 * archivo que lo causó; el `field` del lector (el dato de la factura que falta o es inválido) se
 * conserva. Un XML mayor al tope se rechaza sin decodificarlo.
 */
export function readInvoices<T extends UploadedFile>(
  files: readonly T[],
  maxXmlBytes: number,
): XmlReading<T> {
  const read: ReadInvoice<T>[] = []
  const problems: Problem[] = []
  for (const file of files) {
    if (file.size > maxXmlBytes) {
      problems.push(createProblem('XML_TOO_LARGE', { file: file.originalname }))
      continue
    }
    const result = parseUblInvoice(decodeXml(file.buffer), { maxLength: maxXmlBytes })
    if (result.ok) read.push({ file, invoice: result.invoice })
    else problems.push({ ...result.problem, file: file.originalname })
  }
  return { read, problems }
}
