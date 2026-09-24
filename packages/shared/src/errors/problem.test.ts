import { describe, expect, it } from 'vitest'
import { PROBLEM_CODES } from './codes.js'
import { MESSAGES_ES } from './messages.es.js'
import { createProblem, formatMessage } from './problem.js'
import { VALIDATION_MESSAGES_ES } from './validation-messages.es.js'

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

  it('conserva los parámetros con los que armó el mensaje, para volver a renderizarlo', () => {
    const p = createProblem('TOO_MANY_INVOICES', { data: { max: 10 } })
    expect(p.params).toEqual({ max: 10 })
  })

  it('no agrega params si no hubo datos', () => {
    expect(createProblem('NO_INVOICES', { data: {} })).not.toHaveProperty('params')
    expect(createProblem('NO_INVOICES')).not.toHaveProperty('params')
  })
})

describe('formatMessage', () => {
  it('reemplaza los marcadores conocidos y deja intactos los desconocidos', () => {
    expect(formatMessage('monto de {installment} ({x})', { installment: 'Cuota001' })).toBe(
      'monto de Cuota001 ({x})',
    )
  })
})

describe('VALIDATION_MESSAGES_ES', () => {
  const strings = (value: unknown): string[] =>
    typeof value === 'string'
      ? [value]
      : Object.values(value as Record<string, unknown>).flatMap((v) => strings(v))

  it('todo mensaje de validación es texto no vacío terminado en punto', () => {
    const all = strings(VALIDATION_MESSAGES_ES)
    expect(all.length).toBeGreaterThan(0)
    for (const message of all) expect(message.trim().length, message).toBeGreaterThan(0)
    for (const message of strings(VALIDATION_MESSAGES_ES.advanceRequestForm))
      expect(message.endsWith('.'), message).toBe(true)
  })

  it('las tablas exportadas son de solo lectura en tiempo de compilación', () => {
    // Nunca se ejecuta: solo comprueba con `tsc` que asignar a la tabla no compila.
    const mutate = () => {
      // @ts-expect-error la tabla es de solo lectura
      VALIDATION_MESSAGES_ES.dates.isoDate = 'x'
      // @ts-expect-error la tabla es de solo lectura
      MESSAGES_ES.INVALID_RUC = 'x'
    }
    expect(mutate).toBeTypeOf('function')
  })
})
