import { describe, expect, it } from 'vitest'
import { PROBLEM_CODES } from './codes.js'
import { MESSAGES_ES } from './messages.es.js'
import { createProblem } from './problem.js'

describe('createProblem', () => {
  it('devuelve el código y el mensaje en español', () => {
    const p = createProblem('INVALID_RUC', { field: 'ruc' })
    expect(p).toEqual({ code: 'INVALID_RUC', message: 'El RUC no es válido.', field: 'ruc' })
  })

  it('interpola datos en el mensaje', () => {
    const p = createProblem('TOO_MANY_INVOICES', { data: { max: 10 } })
    expect(p.message).toBe('Puedes enviar como máximo 10 facturas por solicitud.')
  })

  it('omite las propiedades opcionales que no se pasan', () => {
    const p = createProblem('NO_INVOICES')
    expect(Object.keys(p)).toEqual(['code', 'message'])
  })

  it('conserva la regla que lo produjo', () => {
    expect(
      createProblem('CASH_INVOICE', { invoice: 'F001-1', rule: 'credit-with-pending-amount' }).rule,
    ).toBe('credit-with-pending-amount')
  })

  it('todo código tiene mensaje', () => {
    for (const code of PROBLEM_CODES) {
      expect(MESSAGES_ES[code], code).toBeTypeOf('string')
    }
  })
})
