import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { addDaysIso, type IsoDate } from '../dates/index.js'
import { type Amount, type Currency, fromCents, toCents } from '../money/index.js'
import { buildInvoiceXml, type TestXmlOptions } from '../testing/index.js'
import { type ParsedInvoice, parsedInvoiceSchema } from './parsed-invoice.js'
import {
  INVOICE_RULES,
  installmentAmountsPositiveRule,
  invoiceKey,
  issueDateBeforeDueRule,
  issueDateNotInFutureRule,
  netPendingWithinTotalRule,
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

  it('el correlativo con ceros a la izquierda es la misma factura', () => {
    const r = validateInvoices([invoice(), invoice({ seriesNumber: 'F001-00000123' })], ctx)
    expect(codes(r)).toEqual(['DUPLICATE_INVOICE'])
    expect(r.problems[0]?.invoice).toBe('F001-00000123')
  })

  it('el mismo número de otro emisor no es un duplicado', () => {
    const { supplierRuc: _omitted, ...withoutSupplier } = ctx
    const r = validateInvoices([invoice(), invoice({ issuerRuc: '10467286736' })], withoutSupplier)
    expect(codes(r)).toEqual(['MIXED_ISSUERS'])
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
    expect(p?.params).toEqual({ max: '8496.00', currency: 'PEN' })
  })

  it('rechaza montos inválidos aunque lleguen sin validar en runtime', () => {
    expect(validateRequestedAmount('abc' as Amount, result)?.code).toBe('INVALID_AMOUNT')
    expect(validateRequestedAmount('0.00', result)?.code).toBe('INVALID_AMOUNT')
  })

  it('sin máximo calculable devuelve NO_MAXIMUM_AVAILABLE en vez de "máximo de 0.00"', () => {
    const mixed = validateInvoices(
      [invoice(), invoice({ seriesNumber: 'F001-9', currency: 'USD' })],
      ctx,
    )
    const noValid = validateInvoices([invoice({ documentType: '03' })], ctx)
    for (const r of [mixed, noValid, validateInvoices([], ctx)]) {
      const p = validateRequestedAmount('100.00', r)
      expect(p?.code).toBe('NO_MAXIMUM_AVAILABLE')
      expect(p?.message).toBe(
        'No podemos calcular el monto máximo porque las facturas tienen problemas.',
      )
      expect(p?.field).toBe('requestedAmount')
    }
  })

  it('el tipo exige un Amount, no un texto cualquiera', () => {
    const typed = (text: string) => {
      // @ts-expect-error un texto cualquiera no es un Amount
      return validateRequestedAmount(text, result)
    }
    expect(typed).toBeTypeOf('function')
  })
})

describe('invoiceKey', () => {
  it('es RUC del emisor + serie en mayúsculas + correlativo sin ceros a la izquierda', () => {
    const base = { issuerRuc: '20100070970', seriesNumber: 'F001-123' }
    expect(invoiceKey(base)).toBe(invoiceKey({ ...base, seriesNumber: ' f001-00000123 ' }))
    expect(invoiceKey(base)).not.toBe(invoiceKey({ ...base, issuerRuc: '10467286736' }))
    expect(invoiceKey(base)).not.toBe(invoiceKey({ ...base, seriesNumber: 'F002-123' }))
    expect(invoiceKey({ ...base, seriesNumber: 'F001-0' })).toBe(
      invoiceKey({ ...base, seriesNumber: 'F001-00000000' }),
    )
  })
})

describe('tipos de moneda del contexto y del resultado', () => {
  it('las monedas son Currency, no texto', () => {
    const r = validateInvoices([invoice()], ctx)
    const currency: Currency | null = r.currency
    expect(currency).toBe('PEN')
    const invalidContext = () => {
      // @ts-expect-error EUR no es una moneda que el sistema sepa representar
      const c: ValidationContext = { ...ctx, allowedCurrencies: ['EUR'] }
      return c
    }
    expect(invalidContext).toBeTypeOf('function')
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

describe('validateInvoices · propiedades', () => {
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
  const installmentId = fc
    .integer({ min: 1, max: 999 })
    .map((n) => `Cuota${String(n).padStart(3, '0')}`)
  const installment = fc.record({ id: installmentId, amount, dueDate: isoDate })

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

  /**
   * Factura alineada con el contexto y coherente (emitida hasta hoy, cuotas desde la emisión y con
   * monto, neto hasta el total), para que muchas pasen las reglas individuales y lleguen a la suma y
   * al máximo. Las cuotas pueden seguir vencidas o cortas para el plazo mínimo.
   */
  const alignedInvoice = (c: ValidationContext) =>
    fc
      .record({
        seriesNumber,
        issuedDaysAgo: fc.integer({ min: 0, max: 3650 }),
        currency: fc.constantFrom(
          ...(c.allowedCurrencies.length > 0 ? c.allowedCurrencies : ['PEN']),
        ),
        issuerName: fc.string({ maxLength: 40 }),
        amounts: fc.tuple(amount, amount),
        installments: fc.array(
          fc.record({
            id: installmentId,
            amount: fc.bigInt({ min: 1n, max: 10n ** 14n - 1n }).map((cents) => fromCents(cents)),
            daysAfterIssue: fc.integer({ min: 0, max: 3650 }),
          }),
          { minLength: 1, maxLength: 3 },
        ),
      })
      .map(({ issuedDaysAgo, amounts: [a, b], installments, ...rest }) => {
        const issueDate = addDaysIso(c.today, -issuedDaysAgo)
        const [netPendingAmount, total] = toCents(a) <= toCents(b) ? [a, b] : [b, a]
        return {
          ...rest,
          documentType: '01',
          issueDate,
          issuerRuc: c.supplierRuc ?? rucs[0],
          recipientRuc: c.payerRuc,
          recipientName: null,
          total,
          paymentTerms: 'CREDIT',
          netPendingAmount,
          installments: installments.map(({ id, amount: installmentAmount, daysAfterIssue }) => ({
            id,
            amount: installmentAmount,
            dueDate: addDaysIso(issueDate, daysAfterIssue),
          })),
          detraction: null,
          signed: true,
        }
      })

  const scenario = context.chain((c) =>
    fc.tuple(fc.constant(c), fc.array(fc.oneof(anyInvoice, alignedInvoice(c)), { maxLength: 12 })),
  )

  it('nunca lanza, para facturas válidas según parsedInvoiceSchema y un contexto válido', () => {
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

  it('las facturas alineadas llegan a la suma: ninguna regla nueva las filtra', () => {
    const newRules = new Set([
      'issue-date-not-in-future',
      'issue-date-before-due',
      'installment-amounts-positive',
      'net-pending-within-total',
    ])
    fc.assert(
      fc.property(
        context.chain((c) => fc.tuple(fc.constant(c), alignedInvoice(c))),
        ([c, candidate]) => {
          const parsed = parsedInvoiceSchema.parse(candidate) as ParsedInvoice
          const r = validateInvoices([parsed], c)
          return r.problems.every((p) => !newRules.has(p.rule ?? ''))
        },
      ),
      { numRuns: 300 },
    )
  })

  /*
   * Cada regla nueva es exactamente su condición de referencia: la de su CHECK en la base, o
   * `issueDate <= today`. Las fechas ISO `AAAA-MM-DD` de cuatro dígitos se ordenan igual como texto
   * que como fecha, así que la comparación de texto es una referencia independiente de `daysBetween`.
   * `anyParsed` mezcla facturas cualesquiera con coherentes, para que salgan los dos resultados.
   */
  const anyParsed: fc.Arbitrary<ParsedInvoice> = fc
    .oneof(anyInvoice, alignedInvoice(ctx))
    .filter((candidate) => parsedInvoiceSchema.safeParse(candidate).success)
    .map((candidate) => parsedInvoiceSchema.parse(candidate) as ParsedInvoice)

  it('issue-date-not-in-future: problema si y solo si issueDate > today', () => {
    fc.assert(
      fc.property(anyParsed, isoDate, (inv, today) => {
        const problems = issueDateNotInFutureRule.run(inv, { ...ctx, today })
        expect(problems.length > 0).toBe(inv.issueDate > today)
      }),
      { numRuns: 500 },
    )
  })

  it('issue-date-before-due: problema si y solo si alguna cuota vence antes de la emisión', () => {
    fc.assert(
      fc.property(anyParsed, (inv) => {
        const problems = issueDateBeforeDueRule.run(inv, ctx)
        expect(problems.length > 0).toBe(inv.installments.some((i) => i.dueDate < inv.issueDate))
        expect(problems.length).toBeLessThanOrEqual(1)
      }),
      { numRuns: 500 },
    )
  })

  it('installment-amounts-positive: un problema por cada cuota en cero', () => {
    fc.assert(
      fc.property(anyParsed, (inv) => {
        const problems = installmentAmountsPositiveRule.run(inv, ctx)
        expect(problems.length).toBe(
          inv.installments.filter((i) => toCents(i.amount) === 0n).length,
        )
      }),
      { numRuns: 500 },
    )
  })

  it('net-pending-within-total: problema si y solo si hay neto y supera al total', () => {
    fc.assert(
      fc.property(anyParsed, (inv) => {
        const problems = netPendingWithinTotalRule.run(inv, ctx)
        const exceeds =
          inv.netPendingAmount !== null && toCents(inv.netPendingAmount) > toCents(inv.total)
        expect(problems.length > 0).toBe(exceeds)
      }),
      { numRuns: 500 },
    )
  })
})

describe('validateInvoices · reglas nuevas: fecha de emisión y gemelas de las CHECK de la base', () => {
  it('rechaza una factura emitida después de hoy, y acepta la emitida hoy', () => {
    const r = validateInvoices([invoice({ issueDate: '2026-09-24' })], ctx)
    expect(codes(r)).toEqual(['ISSUE_DATE_IN_FUTURE'])
    expect(r.problems[0]).toEqual({
      code: 'ISSUE_DATE_IN_FUTURE',
      message: 'La factura F001-123 tiene fecha de emisión futura.',
      params: { invoice: 'F001-123' },
      invoice: 'F001-123',
      rule: 'issue-date-not-in-future',
    })
    expect(codes(validateInvoices([invoice({ issueDate: '2026-09-23' })], ctx))).toEqual([])
  })

  it('"hoy" sale del contexto, no del reloj de la máquina', () => {
    const inv = invoice({ issueDate: '2026-09-24' })
    expect(issueDateNotInFutureRule.run(inv, { ...ctx, today: '2026-09-24' })).toEqual([])
    expect(issueDateNotInFutureRule.run(inv, { ...ctx, today: '2026-09-23' })).toHaveLength(1)
  })

  it('rechaza una cuota que vence antes de la emisión, con un solo problema por factura', () => {
    const r = validateInvoices(
      [
        invoice({
          issueDate: '2026-12-15',
          installments: [
            { id: 'Cuota001', amount: '5000.00', dueDate: '2026-12-01' },
            { id: 'Cuota002', amount: '5620.00', dueDate: '2026-12-10' },
          ],
        }),
      ],
      { ...ctx, today: '2026-12-20' },
    )
    expect(r.problems.filter((p) => p.rule === 'issue-date-before-due')).toEqual([
      {
        code: 'ISSUE_DATE_AFTER_DUE_DATE',
        message: 'La factura F001-123 vence antes de su fecha de emisión.',
        params: { invoice: 'F001-123' },
        invoice: 'F001-123',
        rule: 'issue-date-before-due',
      },
    ])
    expect(r.validInvoices).toEqual([])
  })

  it('una cuota que vence el mismo día de la emisión no es un problema de fechas', () => {
    const inv = invoice({
      issueDate: '2026-11-30',
      installments: [{ id: 'Cuota001', amount: '10620.00', dueDate: '2026-11-30' }],
    })
    expect(issueDateBeforeDueRule.run(inv, ctx)).toEqual([])
  })

  it('rechaza cada cuota con monto cero, con la cuota y la factura en el mensaje', () => {
    const r = validateInvoices(
      [
        invoice({
          installments: [
            { id: 'Cuota001', amount: '0.00', dueDate: '2026-10-30' },
            { id: 'Cuota002', amount: '10620.00', dueDate: '2026-11-30' },
          ],
        }),
      ],
      ctx,
    )
    expect(codes(r)).toEqual(['INSTALLMENT_AMOUNT_ZERO'])
    expect(r.problems[0]).toMatchObject({
      message: 'La cuota Cuota001 de la factura F001-123 tiene monto cero.',
      params: { installment: 'Cuota001', invoice: 'F001-123' },
      rule: 'installment-amounts-positive',
    })
  })

  it('rechaza un neto pendiente mayor que el total, y acepta uno igual', () => {
    const r = validateInvoices(
      [
        invoice({
          netPendingAmount: '11800.01',
          installments: [{ id: 'Cuota001', amount: '11800.01', dueDate: '2026-11-30' }],
        }),
      ],
      ctx,
    )
    expect(codes(r)).toEqual(['NET_PENDING_EXCEEDS_TOTAL'])
    expect(r.problems[0]?.message).toBe('El neto pendiente de la factura F001-123 supera su total.')
    const equal = invoice({
      netPendingAmount: '11800.00',
      installments: [{ id: 'Cuota001', amount: '11800.00', dueDate: '2026-11-30' }],
    })
    expect(codes(validateInvoices([equal], ctx))).toEqual([])
  })

  it('sin neto pendiente la regla del total no aplica: lo informa credit-with-pending-amount', () => {
    const r = validateInvoices([invoice({ netPendingAmount: null })], ctx)
    expect(codes(r)).toEqual(['NO_PENDING_AMOUNT'])
  })

  it('una factura con varios defectos los informa todos, en el orden de INVOICE_RULES', () => {
    const r = validateInvoices(
      [
        invoice({
          issueDate: '2026-12-01',
          netPendingAmount: '11800.01',
          installments: [{ id: 'Cuota001', amount: '0.00', dueDate: '2026-11-30' }],
        }),
      ],
      ctx,
    )
    expect(codes(r)).toEqual([
      'ISSUE_DATE_IN_FUTURE',
      'ISSUE_DATE_AFTER_DUE_DATE',
      'INSTALLMENT_AMOUNT_ZERO',
      'NET_PENDING_EXCEEDS_TOTAL',
    ])
  })

  it('las cuatro reglas están registradas en RULE_IDS y al final de INVOICE_RULES, en ese orden', () => {
    const ids = [
      'issue-date-not-in-future',
      'issue-date-before-due',
      'installment-amounts-positive',
      'net-pending-within-total',
    ]
    expect(INVOICE_RULES.map((rule) => rule.id).slice(-4)).toEqual(ids)
    for (const id of ids) expect(RULE_IDS).toContain(id)
    expect(new Set(INVOICE_RULES.map((rule) => rule.id)).size).toBe(INVOICE_RULES.length)
  })
})
