import { describe, expect, it } from 'vitest'
import type { PayerConditions } from '../types/payer-conditions.js'
import { buildValidationContext } from './validation-context.js'

const sea: PayerConditions = {
  payerId: '0199a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b',
  slug: 'sea',
  ruc: '20131312955',
  shortName: 'SEA',
  advancePercent: 80,
  minTermDays: 15,
  maxInvoices: 10,
  allowedCurrencies: ['PEN', 'USD'],
}

describe('buildValidationContext', () => {
  it('toma cada parámetro del pagador y el RUC que declaró el proveedor', () => {
    expect(buildValidationContext(sea, '20100070970', '2026-09-24')).toEqual({
      payerRuc: '20131312955',
      payerName: 'SEA',
      supplierRuc: '20100070970',
      advancePercent: 80,
      minTermDays: 15,
      maxInvoices: 10,
      allowedCurrencies: ['PEN', 'USD'],
      today: '2026-09-24',
    })
  })

  it('copia las monedas: cambiar el contexto no cambia las condiciones del pagador', () => {
    const ctx = buildValidationContext(sea, '20100070970', '2026-09-24')
    expect(ctx.allowedCurrencies).not.toBe(sea.allowedCurrencies)
  })

  it('acepta los extremos de cada rango', () => {
    expect(() =>
      buildValidationContext(
        { ...sea, advancePercent: 1, minTermDays: 0, maxInvoices: 1 },
        '20100070970',
        '2026-09-24',
      ),
    ).not.toThrow()
    expect(() =>
      buildValidationContext(
        { ...sea, advancePercent: 100, maxInvoices: 100 },
        '20100070970',
        '2026-09-24',
      ),
    ).not.toThrow()
  })

  it.each([
    [{ advancePercent: 0 }, /advancePercent/],
    [{ advancePercent: 100.5 }, /advancePercent/],
    [{ advancePercent: Number.NaN }, /advancePercent/],
    [{ minTermDays: -1 }, /minTermDays/],
    [{ minTermDays: 1.5 }, /minTermDays/],
    [{ maxInvoices: 0 }, /maxInvoices/],
    [{ maxInvoices: 101 }, /maxInvoices/],
    [{ allowedCurrencies: [] }, /allowedCurrencies/],
    [
      { allowedCurrencies: ['EUR'] as unknown as PayerConditions['allowedCurrencies'] },
      /allowedCurrencies/,
    ],
    [{ ruc: '20131312956' }, /ruc/],
  ])('rechaza un pagador mal configurado (%o) en vez de validar con él', (override, message) => {
    expect(() =>
      buildValidationContext({ ...sea, ...override }, '20100070970', '2026-09-24'),
    ).toThrow(message)
  })

  it('el error nombra al pagador para encontrarlo en el log', () => {
    expect(() =>
      buildValidationContext({ ...sea, maxInvoices: 0 }, '20100070970', '2026-09-24'),
    ).toThrow(new RangeError('Pagador sea: maxInvoices fuera de rango (0)'))
  })
})
