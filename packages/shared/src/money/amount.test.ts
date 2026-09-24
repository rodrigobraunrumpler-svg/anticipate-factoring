import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  amountSchema,
  compareAmounts,
  fromCents,
  normalizeAmount,
  percentOf,
  sumAmounts,
  toCents,
} from './amount.js'

describe('normalizeAmount', () => {
  it.each([
    ['1180.5', '1180.50'],
    ['1180', '1180.00'],
    ['0.1', '0.10'],
    [1180.5, '1180.50'],
    [' 25000.00 ', '25000.00'],
  ])('convierte %s en %s', (input, expected) => {
    expect(normalizeAmount(input)).toBe(expected)
  })

  it.each(['', 'abc', '-5.00', '1,180.50', '1.234', Number.NaN])('rechaza %s', (input) => {
    expect(normalizeAmount(input)).toBeNull()
  })

  it('acepta el monto máximo que cabe en Decimal(14, 2)', () => {
    expect(normalizeAmount('999999999999.99')).toBe('999999999999.99')
  })

  it('rechaza un monto con 13 dígitos enteros, que no cabe en Decimal(14, 2)', () => {
    expect(normalizeAmount('1000000000000.00')).toBeNull()
  })
})

describe('aritmética en céntimos', () => {
  it('convierte ida y vuelta sin perder precisión', () => {
    expect(toCents('25000.00')).toBe(25_000_00n)
    expect(fromCents(25_000_00n)).toBe('25000.00')
    expect(fromCents(5n)).toBe('0.05')
    expect(fromCents(0n)).toBe('0.00')
  })

  it('suma sin errores de coma flotante', () => {
    expect(sumAmounts('0.10', '0.20')).toBe('0.30')
    expect(sumAmounts('10620.00', '5310.50', '0.01')).toBe('15930.51')
  })

  it('calcula porcentajes redondeando hacia abajo al céntimo', () => {
    expect(percentOf('10620.00', 80)).toBe('8496.00')
    expect(percentOf('100.00', 33.33)).toBe('33.33')
    expect(percentOf('0.01', 50)).toBe('0.00')
  })

  it('compara montos', () => {
    expect(compareAmounts('100.00', '100.00')).toBe(0)
    expect(compareAmounts('99.99', '100.00')).toBe(-1)
    expect(compareAmounts('100.01', '100.00')).toBe(1)
  })
})

describe('propiedades del dinero', () => {
  const cents = fc.bigInt({ min: 0n, max: 10n ** 14n - 1n })

  it('fromCents y toCents son inversas', () => {
    fc.assert(fc.property(cents, (c) => toCents(fromCents(c)) === c))
  })

  it('normalizeAmount deja igual lo que ya está normalizado', () => {
    fc.assert(fc.property(cents, (c) => normalizeAmount(fromCents(c)) === fromCents(c)))
  })

  it('sumar montos equivale a sumar céntimos', () => {
    fc.assert(
      fc.property(
        cents,
        cents,
        (a, b) => sumAmounts(fromCents(a), fromCents(b)) === fromCents(a + b),
      ),
    )
  })

  it('el porcentaje nunca supera el monto ni es negativo', () => {
    fc.assert(
      fc.property(cents, fc.integer({ min: 0, max: 100 }), (c, pct) => {
        const r = percentOf(fromCents(c), pct)
        return compareAmounts(r, fromCents(c)) <= 0 && compareAmounts(r, '0.00') >= 0
      }),
    )
  })
})

describe('amountSchema', () => {
  it('acepta solo texto con dos decimales y mayor que cero', () => {
    expect(amountSchema.safeParse('25000.00').success).toBe(true)
    expect(amountSchema.safeParse('0.00').success).toBe(false)
    expect(amountSchema.safeParse('25000').success).toBe(false)
    expect(amountSchema.safeParse(25000).success).toBe(false)
  })

  it('rechaza un monto que no cabe en Decimal(14, 2)', () => {
    expect(amountSchema.safeParse('1000000000000.00').success).toBe(false)
  })
})
