import { createProblem, type Problem } from '@anticipate/shared/errors'
import { invoiceKey, validateInvoices, validateRequestedAmount } from '@anticipate/shared/invoice'
import { pairPdfs } from '#/modules/advance-requests/domain/services/pdf-pairing.js'
import { buildValidationContext } from '#/modules/advance-requests/domain/services/validation-context.js'
import {
  type ReadInvoice,
  readInvoice,
} from '#/modules/advance-requests/domain/services/xml-reading.js'
import type {
  IntakeInvoice,
  InvoiceIntakeInput,
  InvoiceIntakeLimits,
  InvoiceIntakeResult,
  UploadedFile,
} from '#/modules/advance-requests/domain/types/invoice-intake.types.js'

const isPositiveByteCount = (value: number): boolean => Number.isSafeInteger(value) && value > 0

/**
 * Cede el turno al event loop: lo que ya esperaba (otras peticiones, la sonda de vida, el outbox)
 * corre antes de seguir. `setImmediate` y no una promesa resuelta: una microtarea no suelta el
 * event loop.
 */
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/**
 * Admisión de las facturas de una solicitud: lee los XML, empareja los PDF, aplica las reglas de
 * shared con las condiciones del pagador y valida el monto pedido. Junta todos los problemas en una
 * sola respuesta; nunca rechaza por un archivo o un dato del proveedor.
 *
 * Leer un XML es CPU sincrónica: uno de 1 MiB armado a propósito (decenas de miles de etiquetas o
 * atributos con nombres distintos, todo XML válido) lleva de medio segundo a más de uno según la
 * carga de la máquina, y una petición dentro de los topes trae hasta `UPLOAD_MAX_FILES` (20).
 * Leídos de corrido bloquearían el proceso entero de 13 a 30 s: las demás solicitudes, el outbox y
 * la sonda de vida. Por eso `evaluate` es asíncrona y cede el turno antes de cada XML: el bloqueo
 * más largo de una petición es un solo archivo, acotado por `UPLOAD_MAX_XML_BYTES`.
 */
export class InvoiceIntakeService {
  constructor(private readonly limits: InvoiceIntakeLimits) {
    if (!isPositiveByteCount(limits.maxXmlBytes) || !isPositiveByteCount(limits.maxPdfBytes)) {
      throw new RangeError(
        `Topes de archivo inválidos (xml ${limits.maxXmlBytes}, pdf ${limits.maxPdfBytes})`,
      )
    }
  }

  async evaluate(input: InvoiceIntakeInput): Promise<InvoiceIntakeResult> {
    // Primero el contexto: un pagador mal configurado es un error de la plataforma y corta aquí.
    const context = buildValidationContext(input.payer, input.supplierRuc, input.today)
    const reading = await this.readAll(input.xmlFiles)
    const pairing = pairPdfs(input.xmlFiles, input.pdfFiles, this.limits.maxPdfBytes)

    // El máximo de facturas del pagador cuenta los XML recibidos, legibles o no (contrato del
    // endpoint, D38): así TOO_MANY_INVOICES sale junto con los problemas de cada archivo y de cada
    // factura, no en un segundo envío. Sin ningún XML, `validateInvoices` responde NO_INVOICES; si
    // llegaron y ninguno se pudo leer, no lo agrega: ya hay un problema por archivo. Cada problema
    // de una factura lleva el XML que la trajo (`invoiceFiles`, por posición): la serie-número sola
    // no alcanza, dos archivos pueden traer la misma.
    const validation = validateInvoices(
      reading.read.map(({ invoice }) => invoice),
      context,
      {
        xmlFileCount: input.xmlFiles.length,
        invoiceFiles: reading.read.map(({ file }) => file.originalname),
      },
    )
    const problems: Problem[] = [...reading.problems, ...pairing.problems, ...validation.problems]
    // El máximo se calcula sobre las facturas: tiene sentido si todos los XML se leyeron y todas
    // pasan las reglas. Los PDF y los nombres de archivo no cambian las facturas, así que sus
    // problemas no lo ocultan: salen en la misma respuesta.
    if (reading.problems.length === 0 && validation.problems.length === 0) {
      const amountProblem = validateRequestedAmount(input.requestedAmount, validation)
      if (amountProblem !== null) problems.push(amountProblem)
    }
    if (problems.length > 0) return { ok: false, problems }
    // `validateRequestedAmount` ya exige una moneda común; esto solo estrecha el tipo.
    if (validation.currency === null) {
      return {
        ok: false,
        problems: [
          createProblem('NO_MAXIMUM_AVAILABLE', {
            rule: 'requested-amount',
            field: 'requestedAmount',
          }),
        ],
      }
    }

    const invoices: IntakeInvoice[] = reading.read.map(({ file, invoice }) => ({
      invoice,
      key: invoiceKey(invoice),
      xml: file,
      pdf: pairing.pdfByXml.get(file) ?? null,
    }))
    return {
      ok: true,
      invoices,
      currency: validation.currency,
      totalNetPending: validation.totalNetPending,
      maxAmount: validation.maxAmount,
    }
  }

  /** Lee cada XML en el orden recibido, cediendo el turno antes de cada uno. */
  private async readAll(
    files: readonly UploadedFile[],
  ): Promise<{ read: ReadInvoice<UploadedFile>[]; problems: Problem[] }> {
    const read: ReadInvoice<UploadedFile>[] = []
    const problems: Problem[] = []
    for (const file of files) {
      await yieldToEventLoop()
      const reading = readInvoice(file, this.limits.maxXmlBytes)
      if (reading.ok) read.push(reading.read)
      else problems.push(reading.problem)
    }
    return { read, problems }
  }
}
