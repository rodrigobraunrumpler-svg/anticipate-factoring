import { createProblem, type Problem } from '@anticipate/shared/errors'
import { invoiceKey, validateInvoices, validateRequestedAmount } from '@anticipate/shared/invoice'
import { pairPdfs } from '#/modules/advance-requests/domain/services/pdf-pairing.js'
import { buildValidationContext } from '#/modules/advance-requests/domain/services/validation-context.js'
import { readInvoices } from '#/modules/advance-requests/domain/services/xml-reading.js'
import type {
  IntakeInvoice,
  InvoiceIntakeInput,
  InvoiceIntakeLimits,
  InvoiceIntakeResult,
} from '#/modules/advance-requests/domain/types/invoice-intake.types.js'

const isPositiveByteCount = (value: number): boolean => Number.isSafeInteger(value) && value > 0

/**
 * Admisión de las facturas de una solicitud: lee los XML, empareja los PDF, aplica las reglas de
 * shared con las condiciones del pagador y valida el monto pedido. Junta todos los problemas en una
 * sola respuesta; nunca lanza por un archivo o un dato del proveedor.
 */
export class InvoiceIntakeService {
  constructor(private readonly limits: InvoiceIntakeLimits) {
    if (!isPositiveByteCount(limits.maxXmlBytes) || !isPositiveByteCount(limits.maxPdfBytes)) {
      throw new RangeError(
        `Topes de archivo inválidos (xml ${limits.maxXmlBytes}, pdf ${limits.maxPdfBytes})`,
      )
    }
  }

  evaluate(input: InvoiceIntakeInput): InvoiceIntakeResult {
    // Primero el contexto: un pagador mal configurado es un error de la plataforma y corta aquí.
    const context = buildValidationContext(input.payer, input.supplierRuc, input.today)
    const reading = readInvoices(input.xmlFiles, this.limits.maxXmlBytes)
    const pairing = pairPdfs(input.xmlFiles, input.pdfFiles, this.limits.maxPdfBytes)

    // Si ningún XML se pudo leer, "adjunta al menos una factura" sería ruido: ya hay un problema por
    // archivo. Sin ningún XML, en cambio, `validateInvoices` responde NO_INVOICES.
    const nothingReadable = reading.read.length === 0 && reading.problems.length > 0
    const validation = nothingReadable
      ? null
      : validateInvoices(
          reading.read.map(({ invoice }) => invoice),
          context,
        )
    const problems: Problem[] = [
      ...reading.problems,
      ...pairing.problems,
      ...(validation?.problems ?? []),
    ]
    // El máximo se calcula sobre las facturas válidas: solo tiene sentido si todas lo son.
    if (problems.length === 0 && validation !== null) {
      const amountProblem = validateRequestedAmount(input.requestedAmount, validation)
      if (amountProblem !== null) problems.push(amountProblem)
    }
    if (problems.length > 0 || validation === null) return { ok: false, problems }
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
}
