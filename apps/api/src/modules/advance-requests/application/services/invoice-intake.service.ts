import { createProblem, type Problem } from '@anticipate/shared/errors'
import { invoiceKey, validateInvoices, validateRequestedAmount } from '@anticipate/shared/invoice'
import { ServiceUnavailableError } from '#/common/exceptions/index.js'
import type { InvoiceXmlParserPort } from '#/modules/advance-requests/application/ports/invoice-xml-parser.port.js'
import { screenFileNames } from '#/modules/advance-requests/domain/services/file-names.js'
import { pairPdfs } from '#/modules/advance-requests/domain/services/pdf-pairing.js'
import { buildValidationContext } from '#/modules/advance-requests/domain/services/validation-context.js'
import {
  oversizedXmlProblem,
  type ReadInvoice,
  toXmlFileReading,
  unreadableXmlProblem,
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
 * Admisión de las facturas de una solicitud: lee los XML, empareja los PDF, aplica las reglas de
 * shared con las condiciones del pagador y valida el monto pedido. Junta todos los problemas en una
 * sola respuesta; nunca rechaza por un archivo o un dato del proveedor.
 *
 * Leer un XML es CPU sincrónica: uno de 1 MiB armado a propósito (decenas de miles de etiquetas o
 * atributos con nombres distintos, todo XML válido) lleva de medio segundo a más de uno según la
 * carga de la máquina, y una petición dentro de los topes trae hasta `UPLOAD_MAX_FILES` (20). En el
 * hilo principal eso frenaría a toda la API (las demás solicitudes, el outbox y la sonda de vida).
 * Por eso los XML se leen con `InvoiceXmlParserPort`, fuera de ese hilo, uno por vez y en el orden
 * recibido: una petición ocupa como mucho un lugar del lector, así varias se turnan en vez de que una
 * sola lo acapare. Un XML que pasa el tope de tiempo o de memoria del lector es `UNREADABLE_XML`; si
 * el lector está saturado, la solicitud entera es 503 (`ServiceUnavailableError`), sin juzgar el
 * archivo.
 *
 * El nombre de un archivo se repite en `file` de cada problema suyo, y de una factura con cien cuotas
 * salen unos doscientos. Por eso lo primero es `screenFileNames`: un archivo sin un nombre de archivo
 * (más de 255 unidades UTF-16 o con controles) es `INVALID_FILE_NAME`, sin repetir el nombre, y no se
 * lee ni se empareja. Así el 422 queda acotado por los topes de archivos y no por lo que mande el
 * cliente: con los topes por defecto, menos de 4.5 MB en el peor caso (sin el tope, 128 MB).
 */
export class InvoiceIntakeService {
  constructor(
    private readonly limits: InvoiceIntakeLimits,
    private readonly xmlParser: InvoiceXmlParserPort,
  ) {
    if (!isPositiveByteCount(limits.maxXmlBytes) || !isPositiveByteCount(limits.maxPdfBytes)) {
      throw new RangeError(
        `Topes de archivo inválidos (xml ${limits.maxXmlBytes}, pdf ${limits.maxPdfBytes})`,
      )
    }
  }

  async evaluate(input: InvoiceIntakeInput): Promise<InvoiceIntakeResult> {
    // Primero el contexto: un pagador mal configurado es un error de la plataforma y corta aquí.
    const context = buildValidationContext(input.payer, input.supplierRuc, input.today)
    // Un archivo cuyo nombre no se puede repetir se rechaza en la puerta: no se lee ni se empareja.
    const xmlNames = screenFileNames(input.xmlFiles)
    const pdfNames = screenFileNames(input.pdfFiles)
    const reading = await this.readAll(xmlNames.accepted)
    const pairing = pairPdfs(xmlNames.accepted, pdfNames.accepted, this.limits.maxPdfBytes)

    // El máximo de facturas del pagador cuenta los XML recibidos, legibles o no, también los de
    // nombre inválido (contrato del endpoint, D38): así TOO_MANY_INVOICES sale junto con los
    // problemas de cada archivo y de cada factura, no en un segundo envío. Sin ningún XML,
    // `validateInvoices` responde NO_INVOICES; si llegaron y ninguno se pudo leer, no lo agrega: ya
    // hay un problema por archivo. Cada problema de una factura lleva el XML que la trajo
    // (`invoiceFiles`, por posición): la serie-número sola no alcanza, dos archivos pueden traer la
    // misma.
    const validation = validateInvoices(
      reading.read.map(({ invoice }) => invoice),
      context,
      {
        xmlFileCount: input.xmlFiles.length,
        invoiceFiles: reading.read.map(({ file }) => file.originalname),
      },
    )
    const xmlProblems = [...xmlNames.problems, ...reading.problems]
    const problems: Problem[] = [
      ...xmlProblems,
      ...pdfNames.problems,
      ...pairing.problems,
      ...validation.problems,
    ]
    // El máximo se calcula sobre las facturas: tiene sentido si todos los XML se leyeron y todas
    // pasan las reglas. Los PDF y los nombres repetidos no cambian las facturas, así que sus
    // problemas no lo ocultan: salen en la misma respuesta.
    if (xmlProblems.length === 0 && validation.problems.length === 0) {
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

  /**
   * Lee cada XML en el orden recibido, uno por vez. Uno mayor al tope es `XML_TOO_LARGE` sin llegar al
   * lector. Un lector saturado corta la admisión con 503: ningún problema de archivo sale de ahí.
   */
  private async readAll(
    files: readonly UploadedFile[],
  ): Promise<{ read: ReadInvoice<UploadedFile>[]; problems: Problem[] }> {
    const { maxXmlBytes } = this.limits
    const read: ReadInvoice<UploadedFile>[] = []
    const problems: Problem[] = []
    for (const file of files) {
      const oversized = oversizedXmlProblem(file, maxXmlBytes)
      if (oversized !== null) {
        problems.push(oversized)
        continue
      }
      const outcome = await this.xmlParser.parse(file.buffer, { maxLength: maxXmlBytes })
      if (outcome.status === 'unavailable') {
        throw new ServiceUnavailableError(`el lector de XML no está disponible (${outcome.reason})`)
      }
      if (outcome.status === 'too-expensive') {
        problems.push(unreadableXmlProblem(file))
        continue
      }
      const reading = toXmlFileReading(file, outcome.result)
      if (reading.ok) read.push(reading.read)
      else problems.push(reading.problem)
    }
    return { read, problems }
  }
}
