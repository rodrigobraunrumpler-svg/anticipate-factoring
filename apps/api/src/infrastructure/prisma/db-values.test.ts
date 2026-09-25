import { describe, expect, it } from 'vitest'
import { dbDateToIso, decimalToAmount, decimalToNumber, isoDateToDb } from './db-values.js'
import { Prisma } from './generated/client.js'

describe('conversiones con la base', () => {
  it('una fecha de calendario va y vuelve sin correrse de día', () => {
    const db = isoDateToDb('2026-11-30')
    expect(db.toISOString()).toBe('2026-11-30T00:00:00.000Z')
    expect(dbDateToIso(db)).toBe('2026-11-30')
    expect(dbDateToIso(isoDateToDb('2028-02-29'))).toBe('2028-02-29')
  })

  it('un Decimal(14, 2) vuelve como Amount de dos decimales, también en el máximo', () => {
    expect(decimalToAmount(new Prisma.Decimal('8496'))).toBe('8496.00')
    expect(decimalToAmount(new Prisma.Decimal('0.5'))).toBe('0.50')
    expect(decimalToAmount(new Prisma.Decimal('999999999999.99'))).toBe('999999999999.99')
  })

  it('rechaza un Decimal que no es un monto válido en vez de redondearlo', () => {
    expect(() => decimalToAmount(new Prisma.Decimal('-1'))).toThrow(RangeError)
    expect(() => decimalToAmount(new Prisma.Decimal('1.005'))).toThrow(RangeError)
    expect(() => decimalToAmount(new Prisma.Decimal('1000000000000'))).toThrow(RangeError)
  })

  it('un porcentaje Decimal(5, 2) vuelve como número exacto', () => {
    expect(decimalToNumber(new Prisma.Decimal('80.00'))).toBe(80)
    expect(decimalToNumber(new Prisma.Decimal('33.33'))).toBe(33.33)
    expect(() => decimalToNumber(new Prisma.Decimal('0.1234567890123456789'))).toThrow(RangeError)
  })
})
