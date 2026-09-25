import { describe, expect, it } from 'vitest'
import { outboxBackoff } from './outbox-backoff.js'

const options = { baseDelayMs: 30_000, maxDelayMs: 3_600_000 }

describe('outboxBackoff', () => {
  it('duplica la espera en cada intento hasta el tope', () => {
    expect([1, 2, 3, 4, 8, 9].map((attempts) => outboxBackoff(attempts, options, 0))).toEqual([
      30_000, 60_000, 120_000, 240_000, 3_600_000, 3_600_000,
    ])
  })

  it('aplica un jitter de ±10 %', () => {
    expect(outboxBackoff(2, options, 1)).toBe(66_000)
    expect(outboxBackoff(2, options, -1)).toBe(54_000)
  })

  it('rechaza intentos o jitter fuera de rango', () => {
    expect(() => outboxBackoff(0, options, 0)).toThrow(RangeError)
    expect(() => outboxBackoff(1, options, 2)).toThrow(RangeError)
  })
})
