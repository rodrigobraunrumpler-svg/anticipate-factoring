import { describe, expect, it } from 'vitest'
import { InflightBodyBudget } from './inflight-body-budget.js'

describe('InflightBodyBudget', () => {
  it('reserva mientras cabe y rechaza lo que pasaría el tope', () => {
    const budget = new InflightBodyBudget(100)
    const first = budget.tryReserve(60)
    expect(first).not.toBeNull()
    expect(budget.reservedBytes).toBe(60)
    expect(budget.tryReserve(41)).toBeNull()
    const second = budget.tryReserve(40)
    expect(second).not.toBeNull()
    expect(budget.reservedBytes).toBe(100)
    expect(budget.tryReserve(1)).toBeNull()
    first?.()
    expect(budget.reservedBytes).toBe(40)
    expect(budget.tryReserve(60)).not.toBeNull()
  })

  it('liberar dos veces la misma reserva no devuelve bytes de otra', () => {
    const budget = new InflightBodyBudget(100)
    const release = budget.tryReserve(30)
    budget.tryReserve(50)
    release?.()
    release?.()
    expect(budget.reservedBytes).toBe(50)
  })

  it('un cuerpo mayor que el tope no entra ni con el presupuesto vacío; uno vacío siempre entra', () => {
    const budget = new InflightBodyBudget(100)
    expect(budget.tryReserve(101)).toBeNull()
    expect(budget.reservedBytes).toBe(0)
    budget.tryReserve(100)
    expect(budget.tryReserve(0)).not.toBeNull()
  })

  it('rechaza topes y tamaños que no son enteros no negativos', () => {
    for (const maxBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new InflightBodyBudget(maxBytes)).toThrow(RangeError)
    }
    const budget = new InflightBodyBudget(100)
    for (const bytes of [-1, 1.5, Number.NaN]) {
      expect(() => budget.tryReserve(bytes)).toThrow(RangeError)
    }
  })
})
