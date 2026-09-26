import { createProblem, type Problem } from '@anticipate/shared/errors'
import type { UploadedFile } from '../types/invoice-intake.types.js'

const PDF_SIGNATURE = Buffer.from('%PDF-', 'latin1')
/**
 * Los lectores de PDF aceptan la cabecera dentro del primer kilobyte (nota de implementación de la
 * especificación PDF 1.7): algunos generadores dejan bytes antes de `%PDF-`.
 */
const PDF_HEADER_WINDOW = 1024
const BYTES_PER_MB = 1024 * 1024

export type PdfPairing<T extends UploadedFile> = {
  /** PDF de cada XML, por identidad del objeto XML recibido. */
  pdfByXml: Map<T, T>
  problems: Problem[]
}

/** PDF por contenido, no por nombre ni por el tipo que declara el navegador. */
export function isPdf(buffer: Buffer): boolean {
  return buffer.subarray(0, PDF_HEADER_WINDOW).includes(PDF_SIGNATURE)
}

/** Nombre sin ruta ni extensión, en NFC y minúsculas: `C:\docs\F001-123.PDF` → `f001-123`. */
export function baseName(name: string): string {
  const last = name.split(/[\\/]/).pop() ?? name
  const dot = last.lastIndexOf('.')
  return (dot > 0 ? last.slice(0, dot) : last).normalize('NFC').trim().toLowerCase()
}

/** Tope en MB para el mensaje, truncado a dos decimales (nunca anuncia más de lo permitido). */
const megabytes = (bytes: number): number => Math.floor((bytes / BYTES_PER_MB) * 100) / 100

/**
 * Cada PDF (opcional) se asocia al XML con el mismo nombre base. Un PDF mayor al tope, que no es PDF
 * por contenido, sin XML o repetido para el mismo XML es un problema con el nombre del archivo.
 */
export function pairPdfs<T extends UploadedFile>(
  xmls: readonly T[],
  pdfs: readonly T[],
  maxPdfBytes: number,
): PdfPairing<T> {
  const xmlByBase = new Map<string, T>()
  for (const xml of xmls) {
    const base = baseName(xml.originalname)
    if (!xmlByBase.has(base)) xmlByBase.set(base, xml)
  }
  const pdfByXml = new Map<T, T>()
  const problems: Problem[] = []
  for (const pdf of pdfs) {
    const file = pdf.originalname
    if (pdf.size > maxPdfBytes) {
      problems.push(
        createProblem('FILE_TOO_LARGE', { file, data: { file, max: megabytes(maxPdfBytes) } }),
      )
      continue
    }
    if (!isPdf(pdf.buffer)) {
      problems.push(createProblem('INVALID_PDF', { file, data: { file } }))
      continue
    }
    const xml = xmlByBase.get(baseName(file))
    if (xml === undefined || pdfByXml.has(xml)) {
      problems.push(createProblem('PDF_WITHOUT_XML', { file, data: { file } }))
      continue
    }
    pdfByXml.set(xml, pdf)
  }
  return { pdfByXml, problems }
}
