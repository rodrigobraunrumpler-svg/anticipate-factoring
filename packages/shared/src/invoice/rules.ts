import { daysBetween, type IsoDate } from '../dates/index.js'
import { createProblem, type Problem, VALIDATION_MESSAGES_ES } from '../errors/index.js'
import {
  type Amount,
  type Currency,
  compareAmounts,
  fromCents,
  isCurrency,
  MAX_AMOUNT,
  normalizeAmount,
  percentOf,
  toCents,
} from '../money/index.js'
import { DOCUMENT_TYPE, documentTypeName } from './codes.js'
import type { ParsedInvoice } from './parsed-invoice.js'

/** Todo lo que varía por pagador o por configuración. Ninguna regla guarda valores propios. */
export type ValidationContext = {
  payerRuc: string
  payerName: string
  /** Opcional: en la landing las facturas se leen antes de conocer el RUC del proveedor. */
  supplierRuc?: string
  /** 0 a 100. */
  advancePercent: number
  minTermDays: number
  maxInvoices: number
  allowedCurrencies: readonly Currency[]
  today: IsoDate
}

/** Identificadores estables de las reglas. Viajan en `Problem.rule` para métricas. */
export const RULE_IDS = [
  'document-type',
  'recipient-is-payer',
  'issuer-is-supplier',
  'credit-with-pending-amount',
  'currency-allowed',
  'installments-due-in-future',
  'issue-date-not-in-future',
  'issue-date-before-due',
  'installment-amounts-positive',
  'net-pending-within-total',
  'no-invoices',
  'max-invoices',
  'duplicate-invoice',
  'mixed-issuers',
  'mixed-currencies',
  'total-within-limit',
  'requested-amount',
] as const
export type RuleId = (typeof RULE_IDS)[number]

export type InvoiceRule = {
  id: RuleId
  run: (invoice: ParsedInvoice, ctx: ValidationContext) => Problem[]
}

const problemFor = (rule: RuleId, inv: ParsedInvoice, problem: Problem): Problem => ({
  ...problem,
  invoice: inv.seriesNumber,
  rule,
})

export const documentTypeRule: InvoiceRule = {
  id: 'document-type',
  run: (inv) =>
    inv.documentType === DOCUMENT_TYPE.INVOICE
      ? []
      : [
          problemFor(
            'document-type',
            inv,
            createProblem('DOCUMENT_TYPE_NOT_ALLOWED', {
              data: { kind: documentTypeName(inv.documentType) },
            }),
          ),
        ],
}

export const recipientIsPayerRule: InvoiceRule = {
  id: 'recipient-is-payer',
  run: (inv, ctx) =>
    inv.recipientRuc === ctx.payerRuc
      ? []
      : [
          problemFor(
            'recipient-is-payer',
            inv,
            createProblem('RECIPIENT_IS_NOT_PAYER', { data: { payer: ctx.payerName } }),
          ),
        ],
}

export const issuerIsSupplierRule: InvoiceRule = {
  id: 'issuer-is-supplier',
  run: (inv, ctx) =>
    ctx.supplierRuc === undefined || inv.issuerRuc === ctx.supplierRuc
      ? []
      : [
          problemFor(
            'issuer-is-supplier',
            inv,
            createProblem('ISSUER_IS_NOT_SUPPLIER', { data: { issuer: inv.issuerRuc } }),
          ),
        ],
}

export const creditWithPendingAmountRule: InvoiceRule = {
  id: 'credit-with-pending-amount',
  run: (inv) => {
    if (inv.paymentTerms === 'CASH')
      return [problemFor('credit-with-pending-amount', inv, createProblem('CASH_INVOICE'))]
    if (
      inv.paymentTerms !== 'CREDIT' ||
      inv.netPendingAmount === null ||
      toCents(inv.netPendingAmount) === 0n
    ) {
      return [problemFor('credit-with-pending-amount', inv, createProblem('NO_PENDING_AMOUNT'))]
    }
    return []
  },
}

export const currencyAllowedRule: InvoiceRule = {
  id: 'currency-allowed',
  run: (inv, ctx) =>
    isCurrency(inv.currency) && ctx.allowedCurrencies.includes(inv.currency)
      ? []
      : [
          problemFor(
            'currency-allowed',
            inv,
            createProblem('CURRENCY_NOT_ALLOWED', { data: { currency: inv.currency } }),
          ),
        ],
}

export const installmentsDueInFutureRule: InvoiceRule = {
  id: 'installments-due-in-future',
  run: (inv, ctx) => {
    if (inv.paymentTerms !== 'CREDIT') return []
    if (inv.installments.length === 0) {
      return [
        problemFor(
          'installments-due-in-future',
          inv,
          createProblem('XML_MISSING_REQUIRED_FIELD', {
            data: { field: VALIDATION_MESSAGES_ES.invoiceXml.fields.installmentDueDates },
          }),
        ),
      ]
    }
    const problems: Problem[] = []
    for (const installment of inv.installments) {
      const days = daysBetween(ctx.today, installment.dueDate)
      if (days < 0) {
        problems.push(
          problemFor(
            'installments-due-in-future',
            inv,
            createProblem('INSTALLMENT_OVERDUE', {
              data: { installment: installment.id, date: installment.dueDate },
            }),
          ),
        )
      } else if (days < ctx.minTermDays) {
        problems.push(
          problemFor(
            'installments-due-in-future',
            inv,
            createProblem('INSUFFICIENT_TERM', {
              data: { installment: installment.id, days: ctx.minTermDays },
            }),
          ),
        )
      }
    }
    return problems
  },
}

/**
 * Una factura no puede estar emitida después de hoy. No tiene CHECK gemela (una restricción no
 * conoce "hoy"): `ctx.today` lo calcula quien valida; la API, una vez por petición, con
 * `todayIn(LIMA_TIME_ZONE, clock.now())`.
 */
export const issueDateNotInFutureRule: InvoiceRule = {
  id: 'issue-date-not-in-future',
  run: (inv, ctx) =>
    daysBetween(ctx.today, inv.issueDate) <= 0
      ? []
      : [
          problemFor(
            'issue-date-not-in-future',
            inv,
            createProblem('ISSUE_DATE_IN_FUTURE', { data: { invoice: inv.seriesNumber } }),
          ),
        ],
}

/*
 * Reglas gemelas de una restricción CHECK de la base (D49). Cada una es la misma condición que su
 * CHECK, escrita sobre la factura leída: una factura que las pasa nunca hace fallar el INSERT, así
 * que un dato inválido del XML llega al proveedor como un 422 con su problema, nunca como un 503.
 * Si cambia una, cambia su CHECK en la misma versión, y al revés.
 */

/** Gemela de la CHECK `due_date >= issue_date` de `invoices`, sobre cada cuota: un problema por factura. */
export const issueDateBeforeDueRule: InvoiceRule = {
  id: 'issue-date-before-due',
  run: (inv) =>
    inv.installments.every((installment) => daysBetween(inv.issueDate, installment.dueDate) >= 0)
      ? []
      : [
          problemFor(
            'issue-date-before-due',
            inv,
            createProblem('ISSUE_DATE_AFTER_DUE_DATE', { data: { invoice: inv.seriesNumber } }),
          ),
        ],
}

/** Gemela de la CHECK `amount > 0` de `invoice_installments`: un problema por cada cuota en cero. */
export const installmentAmountsPositiveRule: InvoiceRule = {
  id: 'installment-amounts-positive',
  run: (inv) =>
    inv.installments
      .filter((installment) => toCents(installment.amount) === 0n)
      .map((installment) =>
        problemFor(
          'installment-amounts-positive',
          inv,
          createProblem('INSTALLMENT_AMOUNT_ZERO', {
            data: { installment: installment.id, invoice: inv.seriesNumber },
          }),
        ),
      ),
}

/**
 * Gemela de la CHECK `net_pending_amount <= total` de `invoices`. Su otra mitad,
 * `net_pending_amount > 0`, es `credit-with-pending-amount`, que también informa el neto ausente.
 */
export const netPendingWithinTotalRule: InvoiceRule = {
  id: 'net-pending-within-total',
  run: (inv) =>
    inv.netPendingAmount === null || toCents(inv.netPendingAmount) <= toCents(inv.total)
      ? []
      : [
          problemFor(
            'net-pending-within-total',
            inv,
            createProblem('NET_PENDING_EXCEEDS_TOTAL', { data: { invoice: inv.seriesNumber } }),
          ),
        ],
}

/** Orden de evaluación. Agregar una regla = agregar su id a RULE_IDS, un objeto aquí y su test. */
export const INVOICE_RULES: readonly Readonly<InvoiceRule>[] = [
  documentTypeRule,
  recipientIsPayerRule,
  issuerIsSupplierRule,
  creditWithPendingAmountRule,
  currencyAllowedRule,
  installmentsDueInFutureRule,
  issueDateNotInFutureRule,
  issueDateBeforeDueRule,
  installmentAmountsPositiveRule,
  netPendingWithinTotalRule,
]

export type ValidationResult = {
  problems: Problem[]
  validInvoices: ParsedInvoice[]
  /** Moneda común de las facturas válidas, o null si no hay, difieren o su total está fuera de rango. */
  currency: Currency | null
  totalNetPending: Amount
  /** Neto pendiente total × porcentaje de adelanto. "0.00" si no se puede calcular. */
  maxAmount: Amount
}

/**
 * Clave canónica de una factura: RUC del emisor + serie en mayúsculas + correlativo sin ceros a la
 * izquierda (`F001-00000123` ≡ `F001-123`). Es la identidad de la regla de duplicados dentro de la
 * solicitud; la API la usa también para el índice único de facturas activas (STACK §9, D26).
 * Sin expresiones regulares con retroceso: la entrada puede venir de afuera.
 */
export function invoiceKey(invoice: Pick<ParsedInvoice, 'issuerRuc' | 'seriesNumber'>): string {
  const seriesNumber = invoice.seriesNumber.trim().toUpperCase()
  const dash = seriesNumber.lastIndexOf('-')
  const series = dash === -1 ? seriesNumber : seriesNumber.slice(0, dash)
  const number = dash === -1 ? '' : seriesNumber.slice(dash + 1)
  const canonicalNumber = /^\d+$/.test(number) ? number.replace(/^0+(?=\d)/, '') : number
  return `${invoice.issuerRuc.trim()}|${dash === -1 ? series : `${series}-${canonicalNumber}`}`
}

export type ValidateInvoicesOptions = {
  /**
   * Cuántos XML de factura se enviaron, se hayan podido leer o no; por defecto, las facturas
   * recibidas, y nunca cuenta menos que ellas. El máximo de facturas del pagador cuenta los XML
   * enviados (contrato de `POST /api/v1/advance-requests`, D38): uno ilegible también ocupa un lugar.
   * Y si llegaron XML pero ninguno se pudo leer, no se agrega NO_INVOICES: quien los lee ya informó un
   * problema por cada archivo.
   */
  xmlFileCount?: number
}

const emptyResult = (problems: Problem[]): ValidationResult => ({
  problems,
  validInvoices: [],
  currency: null,
  totalNetPending: '0.00',
  maxAmount: '0.00',
})

/**
 * Aplica las reglas a las facturas de una solicitud y calcula el máximo a pedir. Informa todos los
 * problemas juntos, para corregirlos de una vez: con más facturas que el máximo también informa los
 * de cada factura y del conjunto (así el proveedor sabe cuáles quitar), pero no calcula un máximo,
 * porque la solicitud no se puede crear así.
 */
export function validateInvoices(
  invoices: readonly ParsedInvoice[],
  ctx: ValidationContext,
  options: ValidateInvoicesOptions = {},
): ValidationResult {
  const xmlFileCount = Math.max(options.xmlFileCount ?? invoices.length, invoices.length)
  if (xmlFileCount === 0) {
    return emptyResult([createProblem('NO_INVOICES', { rule: 'no-invoices' })])
  }
  const result = evaluateInvoices(invoices, ctx)
  if (xmlFileCount <= ctx.maxInvoices) return result
  const tooMany = createProblem('TOO_MANY_INVOICES', {
    rule: 'max-invoices',
    data: { max: ctx.maxInvoices },
  })
  return emptyResult([tooMany, ...result.problems])
}

/** Duplicados, reglas por factura y reglas del conjunto, sin mirar cuántas facturas son. */
function evaluateInvoices(
  invoices: readonly ParsedInvoice[],
  ctx: ValidationContext,
): ValidationResult {
  const problems: Problem[] = []
  const empty = emptyResult(problems)

  const seen = new Set<string>()
  const candidates: ParsedInvoice[] = []
  for (const inv of invoices) {
    const key = invoiceKey(inv)
    if (seen.has(key)) {
      problems.push(
        createProblem('DUPLICATE_INVOICE', {
          rule: 'duplicate-invoice',
          invoice: inv.seriesNumber,
          data: { invoice: inv.seriesNumber },
        }),
      )
      continue
    }
    seen.add(key)
    candidates.push(inv)
  }

  const validInvoices = candidates.filter((inv) => {
    const own = INVOICE_RULES.flatMap((rule) => rule.run(inv, ctx))
    problems.push(...own)
    return own.length === 0
  })
  if (validInvoices.length === 0) return { ...empty, problems }

  const issuers = new Set(validInvoices.map((inv) => inv.issuerRuc))
  if (issuers.size > 1) problems.push(createProblem('MIXED_ISSUERS', { rule: 'mixed-issuers' }))

  const currencies = new Set(validInvoices.map((inv) => inv.currency))
  if (currencies.size > 1) {
    problems.push(createProblem('MIXED_CURRENCIES', { rule: 'mixed-currencies' }))
    return { ...empty, problems, validInvoices }
  }

  // Suma en céntimos `bigint`, sin tope: los netos vienen del XML y varias facturas pueden superar
  // juntas `Decimal(14, 2)`. Fuera de rango es un problema de la solicitud, nunca una excepción, y
  // `percentOf` solo recibe un total representable.
  const totalCents = validInvoices.reduce(
    (acc, inv) => acc + toCents(inv.netPendingAmount ?? '0.00'),
    0n,
  )
  if (totalCents > toCents(MAX_AMOUNT)) {
    problems.push(createProblem('TOTAL_OUT_OF_RANGE', { rule: 'total-within-limit' }))
    return { ...empty, problems, validInvoices }
  }

  const totalNetPending = fromCents(totalCents)
  // Toda factura válida pasó `currency-allowed`, así que su moneda es un `Currency`.
  const currency = validInvoices[0]?.currency
  return {
    problems,
    validInvoices,
    currency: currency !== undefined && isCurrency(currency) ? currency : null,
    totalNetPending,
    maxAmount: percentOf(totalNetPending, ctx.advancePercent),
  }
}

/**
 * Valida el monto pedido contra el máximo de `validateInvoices`. `amount` ya viene de `amountSchema`;
 * igual se vuelve a comprobar en runtime, porque `Amount` no fija el formato exacto en el tipo.
 */
export function validateRequestedAmount(amount: Amount, result: ValidationResult): Problem | null {
  const normalized = normalizeAmount(amount)
  if (normalized === null || toCents(normalized) === 0n) {
    return createProblem('INVALID_AMOUNT', { rule: 'requested-amount', field: 'requestedAmount' })
  }
  if (result.currency === null || result.validInvoices.length === 0) {
    return createProblem('NO_MAXIMUM_AVAILABLE', {
      rule: 'requested-amount',
      field: 'requestedAmount',
    })
  }
  if (compareAmounts(normalized, result.maxAmount) > 0) {
    return createProblem('AMOUNT_EXCEEDS_MAXIMUM', {
      rule: 'requested-amount',
      field: 'requestedAmount',
      data: { max: result.maxAmount, currency: result.currency },
    })
  }
  return null
}
