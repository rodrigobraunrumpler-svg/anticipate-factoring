import { createProblem, type Problem } from '@anticipate/shared/errors'
import type { UploadedFile } from '../types/invoice-intake.types.js'

/**
 * Cabecera de un PDF (ISO 32000-1, §7.5.2): `%PDF-` y la versión (`1.7`, `2.0`). Delante solo se
 * admite la marca UTF-8 al principio y espacio en blanco de PDF (§7.2.2: NUL, tabulación, LF, FF, CR
 * y espacio). Una página HTML que menciona la firma o un archivo con otros bytes delante no es un PDF.
 */
const PDF_HEADER = /^(?:\xEF\xBB\xBF)?[\0\t\n\f\r ]*%PDF-\d\.\d/
/**
 * Los lectores de PDF aceptan la cabecera dentro del primer kilobyte (nota de implementación de la
 * especificación PDF 1.7): la cabecera entera tiene que caber en esta ventana, así que el espacio en
 * blanco delante nunca pasa de ella.
 */
const PDF_HEADER_WINDOW = 1024
const BYTES_PER_MB = 1024 * 1024

export type PdfPairing<T extends UploadedFile> = {
  /** PDF de cada XML, por identidad del objeto XML recibido. Solo PDF sin problemas. */
  pdfByXml: Map<T, T>
  problems: Problem[]
}

/** PDF por contenido, no por nombre ni por el tipo que declara el navegador. */
export function isPdf(buffer: Buffer): boolean {
  // latin1: un byte, un carácter; ningún byte fuera de ASCII coincide con `\d` ni con la firma.
  return PDF_HEADER.test(buffer.subarray(0, PDF_HEADER_WINDOW).toString('latin1'))
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
 * Cada PDF (opcional) se asocia al XML con el mismo nombre base (`baseName`). Informa todos los
 * problemas de cada archivo, con su nombre:
 * - Dos o más XML con el mismo nombre base: `DUPLICATE_FILE_NAME` por cada nombre distinto, en el
 *   orden de los XML. El navegador descarta la carpeta (`a/factura.xml` y `b/factura.xml` llegan como
 *   `factura.xml`), así que no se sabe de qué factura es un PDF con ese nombre: no se empareja ninguno,
 *   y ese PDF no es `PDF_WITHOUT_XML` (el problema es el nombre de los XML).
 * - Un PDF mayor al tope es `FILE_TOO_LARGE`; si no es PDF por contenido, `INVALID_PDF`; sin XML, o si
 *   su XML ya tiene un PDF antes, `PDF_WITHOUT_XML`. Un PDF puede tener varios. Uno con problemas
 *   igual ocupa el lugar de su XML (así un segundo PDF para ese XML también se informa), pero nunca
 *   queda en `pdfByXml`.
 */
export function pairPdfs<T extends UploadedFile>(
  xmls: readonly T[],
  pdfs: readonly T[],
  maxPdfBytes: number,
): PdfPairing<T> {
  const xmlsByBase = new Map<string, T[]>()
  for (const xml of xmls) {
    const base = baseName(xml.originalname)
    const group = xmlsByBase.get(base)
    if (group === undefined) xmlsByBase.set(base, [xml])
    else group.push(xml)
  }

  const problems: Problem[] = []
  const reported = new Set<string>()
  for (const xml of xmls) {
    const file = xml.originalname
    const sharesBase = (xmlsByBase.get(baseName(file))?.length ?? 0) > 1
    if (!sharesBase || reported.has(file)) continue
    reported.add(file)
    problems.push(createProblem('DUPLICATE_FILE_NAME', { file, data: { file } }))
  }

  const pdfByXml = new Map<T, T>()
  const claimed = new Set<T>()
  for (const pdf of pdfs) {
    const file = pdf.originalname
    const own: Problem[] = []
    if (pdf.size > maxPdfBytes) {
      own.push(
        createProblem('FILE_TOO_LARGE', { file, data: { file, max: megabytes(maxPdfBytes) } }),
      )
    }
    if (!isPdf(pdf.buffer)) own.push(createProblem('INVALID_PDF', { file, data: { file } }))
    const group = xmlsByBase.get(baseName(file)) ?? []
    // Un nombre base de varios XML es ambiguo: ya lo informa DUPLICATE_FILE_NAME.
    if (group.length <= 1) {
      const [xml] = group
      if (xml === undefined || claimed.has(xml)) {
        own.push(createProblem('PDF_WITHOUT_XML', { file, data: { file } }))
      } else {
        claimed.add(xml)
        if (own.length === 0) pdfByXml.set(xml, pdf)
      }
    }
    problems.push(...own)
  }
  return { pdfByXml, problems }
}
