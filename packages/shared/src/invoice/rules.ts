import { daysBetween, type IsoDate } from '../dates/index.js'
import { createProblem, type Problem, VALIDATION_MESSAGES_ES } from '../errors/index.js'
import {
  type Amount,
  compareAmounts,
  normalizeAmount,
  percentOf,
  sumAmounts,
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
  allowedCurrencies: readonly string[]
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
  'no-invoices',
  'max-invoices',
  'duplicate-invoice',
  'mixed-issuers',
  'mixed-currencies',
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
    ctx.allowedCurrencies.includes(inv.currency)
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

/** Orden de evaluación. Agregar una regla = agregar su id a RULE_IDS, un objeto aquí y su test. */
export const INVOICE_RULES: readonly InvoiceRule[] = [
  documentTypeRule,
  recipientIsPayerRule,
  issuerIsSupplierRule,
  creditWithPendingAmountRule,
  currencyAllowedRule,
  installmentsDueInFutureRule,
]

export type ValidationResult = {
  problems: Problem[]
  validInvoices: ParsedInvoice[]
  /** Moneda común de las facturas válidas, o null si no hay o difieren. */
  currency: string | null
  totalNetPending: Amount
  /** Neto pendiente total × porcentaje de adelanto. "0.00" si no se puede calcular. */
  maxAmount: Amount
}

const invoiceKey = (inv: ParsedInvoice) => inv.seriesNumber.trim().toUpperCase()

export function validateInvoices(
  invoices: readonly ParsedInvoice[],
  ctx: ValidationContext,
): ValidationResult {
  const problems: Problem[] = []
  const empty: ValidationResult = {
    problems,
    validInvoices: [],
    currency: null,
    totalNetPending: '0.00',
    maxAmount: '0.00',
  }

  if (invoices.length === 0) {
    problems.push(createProblem('NO_INVOICES', { rule: 'no-invoices' }))
    return empty
  }
  if (invoices.length > ctx.maxInvoices) {
    problems.push(
      createProblem('TOO_MANY_INVOICES', { rule: 'max-invoices', data: { max: ctx.maxInvoices } }),
    )
    return empty
  }

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

  const totalNetPending = sumAmounts(...validInvoices.map((inv) => inv.netPendingAmount ?? '0.00'))
  return {
    problems,
    validInvoices,
    currency: validInvoices[0]?.currency ?? null,
    totalNetPending,
    maxAmount: percentOf(totalNetPending, ctx.advancePercent),
  }
}

export function validateRequestedAmount(amount: string, result: ValidationResult): Problem | null {
  const normalized = normalizeAmount(amount)
  if (normalized === null || toCents(normalized) === 0n) {
    return createProblem('INVALID_AMOUNT', { rule: 'requested-amount', field: 'requestedAmount' })
  }
  if (compareAmounts(normalized, result.maxAmount) > 0) {
    return createProblem('AMOUNT_EXCEEDS_MAXIMUM', {
      rule: 'requested-amount',
      field: 'requestedAmount',
      data: { max: result.maxAmount, currency: result.currency ?? '' },
    })
  }
  return null
}
