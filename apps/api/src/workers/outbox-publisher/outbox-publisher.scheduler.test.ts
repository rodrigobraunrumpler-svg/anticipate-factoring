import { describe, expect, it } from 'vitest'
import { nextPassDelayMs } from './outbox-publisher.scheduler.js'

describe('nextPassDelayMs', () => {
  const pollIntervalMs = 5_000

  it('sin eventos pendientes espera el intervalo completo', () => {
    expect(nextPassDelayMs({ processed: 3, nextDueMs: null, pollIntervalMs })).toBe(5_000)
  })

  it('despierta con el próximo evento, acotado por el intervalo', () => {
    expect(nextPassDelayMs({ processed: 1, nextDueMs: 1_200.4, pollIntervalMs })).toBe(1_201)
    expect(nextPassDelayMs({ processed: 0, nextDueMs: 60_000, pollIntervalMs })).toBe(5_000)
    expect(nextPassDelayMs({ processed: 20, nextDueMs: -30, pollIntervalMs })).toBe(0)
  })

  it('si la pasada no procesó nada y hay algo vencido, no consulta en bucle', () => {
    expect(nextPassDelayMs({ processed: 0, nextDueMs: 0, pollIntervalMs })).toBe(5_000)
  })
})
