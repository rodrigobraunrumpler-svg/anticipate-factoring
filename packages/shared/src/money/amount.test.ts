import Decimal from 'decimal.js'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Amount } from './amount.js'
import {
  amountSchema,
  compareAmounts,
  fromCents,
  fromDecimal,
  normalizeAmount,
  percentOf,
  sumAmounts,
  toCents,
  toDecimal,
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

  it('rechaza céntimos negativos', () => {
    expect(() => fromCents(-1n)).toThrow(RangeError)
    expect(() => fromCents(-100n)).toThrow(RangeError)
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

describe('puente con decimal.js', () => {
  it('toDecimal y fromDecimal conservan el monto', () => {
    expect(fromDecimal(toDecimal('25000.00'), 'down')).toBe('25000.00')
    expect(toDecimal('0.10').plus(toDecimal('0.20')).toFixed(2)).toBe('0.30')
  })

  it('fromDecimal redondea según el modo declarado', () => {
    expect(fromDecimal('10.005', 'half-up')).toBe('10.01')
    expect(fromDecimal('10.005', 'down')).toBe('10.00')
    expect(fromDecimal('10.009', 'down')).toBe('10.00')
    expect(fromDecimal('10.004', 'half-up')).toBe('10.00')
  })

  it('fromDecimal rechaza negativos, no finitos y montos fuera de Decimal(14, 2)', () => {
    expect(() => fromDecimal('-0.01', 'down')).toThrow(RangeError)
    expect(() => fromDecimal(Number.NaN, 'down')).toThrow(RangeError)
    expect(() => fromDecimal(Number.POSITIVE_INFINITY, 'down')).toThrow(RangeError)
    expect(() => fromDecimal('1000000000000.00', 'down')).toThrow(RangeError)
    expect(fromDecimal('999999999999.994', 'down')).toBe('999999999999.99')
    expect(() => fromDecimal('999999999999.995', 'half-up')).toThrow(RangeError)
  })

  it('la configuración global de decimal.js no afecta al dominio', () => {
    const previous = Decimal.rounding
    Decimal.set({ rounding: Decimal.ROUND_UP })
    try {
      expect(percentOf('0.01', 50)).toBe('0.00')
      expect(percentOf('100.00', 33.333)).toBe('33.33')
    } finally {
      Decimal.set({ rounding: previous })
    }
  })

  it('percentOf usa el porcentaje decimal exacto', () => {
    expect(percentOf('100.00', 33.33)).toBe('33.33')
    expect(percentOf('1000.00', 0.1)).toBe('1.00')
    expect(percentOf('999999999999.99', 100)).toBe('999999999999.99')
  })
})

describe('propiedades del puente', () => {
  const cents = fc.bigInt({ min: 0n, max: 10n ** 14n - 1n })

  it('fromDecimal(toDecimal(x)) === x', () => {
    fc.assert(
      fc.property(cents, (c) => fromDecimal(toDecimal(fromCents(c)), 'down') === fromCents(c)),
    )
  })

  it('sumar con decimal.js equivale a sumar céntimos', () => {
    fc.assert(
      fc.property(cents, cents, (a, b) => {
        fc.pre(a + b <= 10n ** 14n - 1n)
        return sumAmounts(fromCents(a), fromCents(b)) === fromCents(a + b)
      }),
    )
  })
})

describe('tipo Amount', () => {
  it('rechaza en tiempo de compilación un string cualquiera', () => {
    const plain: string = 'x'
    // @ts-expect-error un string cualquiera no es un Amount
    const notAmount: Amount = plain
    // @ts-expect-error texto sin punto decimal no es un Amount
    const noDecimals: Amount = '25000'
    void notAmount
    void noDecimals
  })
})
