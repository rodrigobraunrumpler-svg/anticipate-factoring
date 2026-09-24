import { describe, expect, it } from 'vitest'
import { VALIDATION_MESSAGES_ES } from '../errors/index.js'
import { currencySchema } from './currency.js'

describe('currencySchema', () => {
  it('acepta PEN y USD, y rechaza otra moneda con mensaje en español', () => {
    expect(currencySchema.parse('PEN')).toBe('PEN')
    const r = currencySchema.safeParse('EUR')
    expect(!r.success && r.error.issues[0]?.message).toBe(VALIDATION_MESSAGES_ES.money.currency)
  })
})
