import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { IsoDate } from '../dates/index.js'
import { type Amount, fromCents } from '../money/index.js'
import { buildInvoiceXml, type TestXmlOptions } from '../testing/index.js'
import { type ParsedInvoice, parsedInvoiceSchema } from './parsed-invoice.js'
import {
  INVOICE_RULES,
  RULE_IDS,
  type ValidationContext,
  validateInvoices,
  validateRequestedAmount,
} from './rules.js'
import { parseUblInvoice } from './ubl-parser.js'

function invoice(options: TestXmlOptions = {}) {
  const r = parseUblInvoice(buildInvoiceXml(options))
  if (!r.ok) throw new Error(r.problem.code)
  return r.invoice
}

const ctx: ValidationContext = {
  payerRuc: '20131312955',
  payerName: 'SEA',
  supplierRuc: '20100070970',
  advancePercent: 80,
  minTermDays: 15,
  maxInvoices: 10,
  allowedCurrencies: ['PEN', 'USD'],
  today: '2026-09-23',
}

const codes = (r: ReturnType<typeof validateInvoices>) => r.problems.map((p) => p.code)

describe('validateInvoices · caso válido', () => {
  it('acepta una factura al crédito al pagador, del proveedor, con cuota futura', () => {
    const r = validateInvoices([invoice()], ctx)
    expect(r.problems).toEqual([])
    expect(r.validInvoices).toHaveLength(1)
    expect(r.currency).toBe('PEN')
    expect(r.totalNetPending).toBe('10620.00')
    expect(r.maxAmount).toBe('8496.00')
  })

  it('suma el neto pendiente de varias facturas y calcula el máximo con el porcentaje del contexto', () => {
    const r = validateInvoices(
      [invoice(), invoice({ seriesNumber: 'F001-124', netPendingAmount: '1000.00' })],
      { ...ctx, advancePercent: 50 },
    )
    expect(r.totalNetPending).toBe('11620.00')
    expect(r.maxAmount).toBe('5810.00')
  })
})

describe('validateInvoices · reglas por factura', () => {
  it('rechaza una boleta', () => {
    const r = validateInvoices([invoice({ documentType: '03' })], ctx)
    expect(codes(r)).toEqual(['DOCUMENT_TYPE_NOT_ALLOWED'])
    expect(r.problems[0]?.invoice).toBe('F001-123')
    expect(r.problems[0]?.rule).toBe('document-type')
    expect(r.problems[0]?.message).toContain('boleta de venta')
  })

  it('cada problema lleva el id de la regla que lo produjo, y los ids son únicos', () => {
    const r = validateInvoices([invoice({ documentType: '03', currency: 'EUR' })], ctx)
    expect(r.problems.map((p) => p.rule)).toEqual(['document-type', 'currency-allowed'])
    expect(new Set(INVOICE_RULES.map((rule) => rule.id)).size).toBe(INVOICE_RULES.length)
  })

  it('rechaza una factura emitida a otro receptor', () => {
    const r = validateInvoices([invoice({ recipientRuc: '20100070970' })], ctx)
    expect(codes(r)).toEqual(['RECIPIENT_IS_NOT_PAYER'])
    expect(r.problems[0]?.message).toContain('SEA')
  })

  it('rechaza una factura de otro emisor cuando el contexto trae el RUC del proveedor', () => {
    const r = validateInvoices([invoice({ issuerRuc: '10467286736' })], ctx)
    expect(codes(r)).toEqual(['ISSUER_IS_NOT_SUPPLIER'])
  })

  it('no aplica la regla del emisor si el contexto no trae el RUC del proveedor', () => {
    const { supplierRuc: _omitted, ...withoutSupplier } = ctx
    const r = validateInvoices([invoice({ issuerRuc: '10467286736' })], withoutSupplier)
    expect(codes(r)).toEqual([])
  })

  it('rechaza una factura al contado', () => {
    const r = validateInvoices(
      [invoice({ paymentTerms: 'Contado', netPendingAmount: null, installments: [] })],
      ctx,
    )
    expect(codes(r)).toEqual(['CASH_INVOICE'])
  })

  it('rechaza una factura sin forma de pago o sin neto pendiente', () => {
    expect(
      codes(validateInvoices([invoice({ paymentTerms: null, installments: [] })], ctx)),
    ).toEqual(['NO_PENDING_AMOUNT'])
    expect(codes(validateInvoices([invoice({ netPendingAmount: '0.00' })], ctx))).toEqual([
      'NO_PENDING_AMOUNT',
    ])
  })

  it('rechaza una moneda que el pagador no acepta', () => {
    const r = validateInvoices([invoice({ currency: 'EUR' })], {
      ...ctx,
      allowedCurrencies: ['PEN'],
    })
    expect(codes(r)).toEqual(['CURRENCY_NOT_ALLOWED'])
  })

  it('señala la cuota vencida aunque otra sea futura', () => {
    const r = validateInvoices(
      [
        invoice({
          installments: [
            { id: 'Cuota001', amount: '5000.00', dueDate: '2026-09-01' },
            { id: 'Cuota002', amount: '5620.00', dueDate: '2026-12-01' },
          ],
        }),
      ],
      ctx,
    )
    expect(codes(r)).toEqual(['INSTALLMENT_OVERDUE'])
    expect(r.problems[0]?.message).toContain('Cuota001')
  })

  it('exige el plazo mínimo del contexto', () => {
    const r = validateInvoices(
      [invoice({ installments: [{ id: 'Cuota001', amount: '10620.00', dueDate: '2026-10-01' }] })],
      ctx,
    )
    expect(codes(r)).toEqual(['INSUFFICIENT_TERM'])
    const ok = validateInvoices(
      [invoice({ installments: [{ id: 'Cuota001', amount: '10620.00', dueDate: '2026-10-08' }] })],
      ctx,
    )
    expect(codes(ok)).toEqual([])
  })

  it('una factura al crédito sin cuotas es un dato obligatorio ausente', () => {
    expect(codes(validateInvoices([invoice({ installments: [] })], ctx))).toEqual([
      'XML_MISSING_REQUIRED_FIELD',
    ])
  })
})

describe('validateInvoices · reglas del conjunto', () => {
  it('rechaza una solicitud sin facturas, con el id de la regla del conjunto', () => {
    const r = validateInvoices([], ctx)
    expect(codes(r)).toEqual(['NO_INVOICES'])
    expect(r.problems[0]?.rule).toBe('no-invoices')
  })

  it('rechaza más facturas que el máximo del contexto', () => {
    const three = ['F001-1', 'F001-2', 'F001-3'].map((seriesNumber) => invoice({ seriesNumber }))
    expect(codes(validateInvoices(three, { ...ctx, maxInvoices: 2 }))).toEqual([
      'TOO_MANY_INVOICES',
    ])
  })

  it('rechaza la misma factura repetida, ignorando mayúsculas y espacios', () => {
    const r = validateInvoices([invoice(), invoice({ seriesNumber: ' f001-123 ' })], ctx)
    expect(codes(r)).toEqual(['DUPLICATE_INVOICE'])
  })

  it('rechaza emisores distintos cuando no hay RUC del proveedor en el contexto', () => {
    const { supplierRuc: _omitted, ...withoutSupplier } = ctx
    const r = validateInvoices(
      [invoice(), invoice({ seriesNumber: 'F001-9', issuerRuc: '10467286736' })],
      withoutSupplier,
    )
    expect(codes(r)).toEqual(['MIXED_ISSUERS'])
  })

  it('rechaza monedas distintas y no calcula máximo', () => {
    const r = validateInvoices(
      [invoice(), invoice({ seriesNumber: 'F001-9', currency: 'USD' })],
      ctx,
    )
    expect(codes(r)).toEqual(['MIXED_CURRENCIES'])
    expect(r.currency).toBeNull()
    expect(r.maxAmount).toBe('0.00')
  })

  it('las facturas con problemas no cuentan para el máximo', () => {
    const r = validateInvoices(
      [invoice(), invoice({ seriesNumber: 'F001-9', paymentTerms: 'Contado', installments: [] })],
      ctx,
    )
    expect(r.validInvoices).toHaveLength(1)
    expect(r.maxAmount).toBe('8496.00')
  })
})

describe('validateRequestedAmount', () => {
  const result = validateInvoices([invoice()], ctx)

  it('acepta un monto hasta el máximo', () => {
    expect(validateRequestedAmount('8496.00', result)).toBeNull()
    expect(validateRequestedAmount('100.00', result)).toBeNull()
  })

  it('rechaza un monto mayor al máximo con el máximo y la moneda en el mensaje', () => {
    const p = validateRequestedAmount('8496.01', result)
    expect(p?.code).toBe('AMOUNT_EXCEEDS_MAXIMUM')
    expect(p?.message).toBe('El monto solicitado supera el máximo de 8496.00 PEN.')
  })

  it('rechaza montos inválidos', () => {
    expect(validateRequestedAmount('abc', result)?.code).toBe('INVALID_AMOUNT')
    expect(validateRequestedAmount('0.00', result)?.code).toBe('INVALID_AMOUNT')
  })
})

describe('validateInvoices · montos fuera de rango', () => {
  const huge = '999999999999.99'
  const hugeInvoice = (seriesNumber: string) =>
    invoice({
      seriesNumber,
      total: huge,
      netPendingAmount: huge,
      installments: [{ id: 'Cuota001', amount: huge, dueDate: '2026-11-30' }],
    })

  it('dos facturas con el neto máximo: problema TOTAL_OUT_OF_RANGE, sin excepción', () => {
    const invoices = [hugeInvoice('F001-1'), hugeInvoice('F001-2')]
    expect(() => validateInvoices(invoices, ctx)).not.toThrow()
    const r = validateInvoices(invoices, ctx)
    expect(codes(r)).toEqual(['TOTAL_OUT_OF_RANGE'])
    expect(r.problems[0]?.rule).toBe('total-within-limit')
    expect(r.problems[0]?.message).toBe(
      'La suma de las facturas supera el monto máximo que podemos procesar.',
    )
    expect(r.maxAmount).toBe('0.00')
    expect(r.validInvoices).toHaveLength(2)
  })

  it('una sola factura con el neto máximo sigue siendo procesable', () => {
    const r = validateInvoices([hugeInvoice('F001-1')], { ...ctx, advancePercent: 100 })
    expect(r.problems).toEqual([])
    expect(r.totalNetPending).toBe(huge)
    expect(r.maxAmount).toBe(huge)
  })

  it('la regla total-within-limit está registrada', () => {
    expect(RULE_IDS).toContain('total-within-limit')
  })
})

describe('validateInvoices · propiedad: nunca lanza', () => {
  const rucs = ['20100070970', '20131312955', '10467286736'] as const
  const amount = fc.oneof(
    fc.bigInt({ min: 0n, max: 10n ** 14n - 1n }).map((c) => fromCents(c)),
    fc.constant<Amount>('999999999999.99'),
  )
  const isoDate = fc
    .date({
      min: new Date('2000-01-01T00:00:00Z'),
      max: new Date('2099-12-31T00:00:00Z'),
      noInvalidDate: true,
    })
    .map((d) => d.toISOString().slice(0, 10) as IsoDate)
  const seriesNumber = fc
    .tuple(fc.stringMatching(/^[A-Z0-9]{4}$/), fc.integer({ min: 0, max: 99_999_999 }))
    .map(([series, n]) => `${series}-${n}`)
  const installment = fc.record({
    id: fc.integer({ min: 1, max: 999 }).map((n) => `Cuota${String(n).padStart(3, '0')}`),
    amount,
    dueDate: isoDate,
  })

  const context: fc.Arbitrary<ValidationContext> = fc.record(
    {
      payerRuc: fc.constantFrom(...rucs),
      payerName: fc.string({ maxLength: 20 }),
      supplierRuc: fc.constantFrom(...rucs),
      advancePercent: fc.double({ min: 0, max: 100, noNaN: true }),
      minTermDays: fc.integer({ min: 0, max: 400 }),
      maxInvoices: fc.integer({ min: 1, max: 20 }),
      allowedCurrencies: fc.subarray(['PEN', 'USD'] as const),
      today: isoDate,
    },
    {
      requiredKeys: [
        'payerRuc',
        'payerName',
        'advancePercent',
        'minTermDays',
        'maxInvoices',
        'allowedCurrencies',
        'today',
      ],
    },
  )

  /** Cualquier factura que acepte `parsedInvoiceSchema`. */
  const anyInvoice = fc.record({
    documentType: fc.constantFrom('01', '03', '07'),
    seriesNumber,
    issueDate: isoDate,
    currency: fc.constantFrom('PEN', 'USD', 'EUR'),
    issuerRuc: fc.constantFrom(...rucs),
    issuerName: fc.string({ maxLength: 40 }),
    recipientRuc: fc.constantFrom(...rucs),
    recipientName: fc.option(fc.string({ maxLength: 40 }), { nil: null }),
    total: amount,
    paymentTerms: fc.constantFrom('CASH', 'CREDIT', null),
    netPendingAmount: fc.option(amount, { nil: null }),
    installments: fc.array(installment, { maxLength: 4 }),
    detraction: fc.option(fc.record({ percent: fc.integer({ min: 0, max: 100 }), amount }), {
      nil: null,
    }),
    signed: fc.boolean(),
  })

  /** Factura que pasa las reglas individuales del contexto, para llegar a la suma y al máximo. */
  const alignedInvoice = (c: ValidationContext) =>
    fc.record({
      documentType: fc.constant('01'),
      seriesNumber,
      issueDate: isoDate,
      currency: fc.constantFrom(
        ...(c.allowedCurrencies.length > 0 ? c.allowedCurrencies : ['PEN']),
      ),
      issuerRuc: fc.constant(c.supplierRuc ?? rucs[0]),
      issuerName: fc.string({ maxLength: 40 }),
      recipientRuc: fc.constant(c.payerRuc),
      recipientName: fc.constant(null),
      total: amount,
      paymentTerms: fc.constant('CREDIT'),
      netPendingAmount: amount,
      installments: fc.array(installment, { minLength: 1, maxLength: 3 }),
      detraction: fc.constant(null),
      signed: fc.constant(true),
    })

  const scenario = context.chain((c) =>
    fc.tuple(fc.constant(c), fc.array(fc.oneof(anyInvoice, alignedInvoice(c)), { maxLength: 12 })),
  )

  it('para facturas válidas según parsedInvoiceSchema y un contexto válido', () => {
    fc.assert(
      fc.property(scenario, ([c, candidates]) => {
        const invoices = candidates.flatMap((candidate) => {
          const parsed = parsedInvoiceSchema.safeParse(candidate)
          return parsed.success ? [parsed.data as ParsedInvoice] : []
        })
        const r = validateInvoices(invoices, c)
        return Array.isArray(r.problems)
      }),
      { numRuns: 500 },
    )
  })
})
