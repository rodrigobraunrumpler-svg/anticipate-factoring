import { describe, expect, expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import { API_MESSAGES_ES } from './api-messages.es.js'
import { PROBLEM_CODES, type ProblemCode } from './codes.js'
import { MESSAGES_ES } from './messages.es.js'
import { createProblem, formatMessage, type Problem, problemSchema } from './problem.js'
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

describe('códigos de la recepción de solicitudes y de las reglas nuevas', () => {
  it('interpolan sus datos en español', () => {
    const cases: readonly [Problem, string][] = [
      [
        createProblem('PAYER_NOT_AVAILABLE', { data: { payer: 'sea' } }),
        'El programa de adelanto «sea» no está disponible.',
      ],
      [
        createProblem('FILE_TOO_LARGE', { data: { file: 'f1.pdf', max: 10 } }),
        'El archivo f1.pdf supera el máximo de 10 MB.',
      ],
      [
        createProblem('INVALID_PDF', { data: { file: 'f1.pdf' } }),
        'El archivo f1.pdf no es un PDF válido.',
      ],
      [
        createProblem('PDF_WITHOUT_XML', { data: { file: 'f9.pdf' } }),
        'El PDF f9.pdf no corresponde a ninguna factura XML adjunta.',
      ],
      [
        createProblem('INVOICE_ALREADY_IN_OPEN_REQUEST', { data: { invoice: 'F001-123' } }),
        'La factura F001-123 ya está en otra solicitud en curso.',
      ],
      [
        createProblem('CONSENT_VERSION_OUTDATED', { field: 'consents.termsVersion' }),
        'Los términos o la política de privacidad cambiaron. Recarga la página y acéptalos de nuevo.',
      ],
      [
        createProblem('ISSUE_DATE_IN_FUTURE', { data: { invoice: 'F001-123' } }),
        'La factura F001-123 tiene fecha de emisión futura.',
      ],
      [
        createProblem('ISSUE_DATE_AFTER_DUE_DATE', { data: { invoice: 'F001-123' } }),
        'La factura F001-123 vence antes de su fecha de emisión.',
      ],
      [
        createProblem('NET_PENDING_EXCEEDS_TOTAL', { data: { invoice: 'F001-123' } }),
        'El neto pendiente de la factura F001-123 supera su total.',
      ],
      [
        createProblem('INSTALLMENT_AMOUNT_ZERO', {
          data: { installment: 'Cuota001', invoice: 'F001-123' },
        }),
        'La cuota Cuota001 de la factura F001-123 tiene monto cero.',
      ],
    ]
    for (const [problem, message] of cases) expect(problem.message, problem.code).toBe(message)
  })
})

describe('Problem.file', () => {
  it('indica el archivo al que se refiere, sin confundirlo con el campo', () => {
    const p = createProblem('XML_MISSING_REQUIRED_FIELD', {
      file: 'F001-1.xml',
      field: 'issuerRuc',
      data: { field: 'RUC del emisor' },
    })
    expect(p).toEqual({
      code: 'XML_MISSING_REQUIRED_FIELD',
      message: 'El XML no contiene el dato "RUC del emisor".',
      field: 'issuerRuc',
      file: 'F001-1.xml',
      params: { field: 'RUC del emisor' },
    })
  })

  it('no aparece si no se pasa, aunque el mensaje nombre un archivo', () => {
    expect(createProblem('NO_INVOICES')).not.toHaveProperty('file')
    expect(createProblem('INVALID_PDF', { data: { file: 'a.pdf' } })).not.toHaveProperty('file')
  })
})

describe('problemSchema', () => {
  it('acepta todo lo que produce createProblem', () => {
    const produced = [
      createProblem('NO_INVOICES'),
      createProblem('INVALID_PDF', { file: 'a.pdf', data: { file: 'a.pdf' } }),
      createProblem('CASH_INVOICE', { invoice: 'F001-1', rule: 'credit-with-pending-amount' }),
      createProblem('TOO_MANY_INVOICES', { data: { max: 10 } }),
      createProblem('CONSENT_VERSION_OUTDATED', { field: 'consents.privacyVersion' }),
    ]
    for (const problem of produced) expect(problemSchema.parse(problem)).toEqual(problem)
  })

  it('acepta el nombre de archivo tal como llegó, aunque venga vacío', () => {
    const p = createProblem('INVALID_PDF', { file: '', data: { file: '' } })
    expect(problemSchema.parse(p)).toEqual(p)
  })

  it('rechaza un código desconocido, un mensaje vacío, una propiedad de más o un opcional undefined', () => {
    const base = createProblem('NO_INVOICES')
    for (const bad of [
      { ...base, code: 'NOPE' },
      { ...base, message: '' },
      { ...base, stack: 'Error: x' },
      { ...base, file: undefined },
      { ...base, invoice: '' },
      { ...base, params: { max: true } },
    ]) {
      expect(problemSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('su salida es un Problem', () => {
    expectTypeOf<z.output<typeof problemSchema>>().toEqualTypeOf<{
      code: ProblemCode
      message: string
      invoice?: string
      field?: string
      file?: string
      rule?: string
      params?: Record<string, string | number>
    }>()
    expectTypeOf<z.output<typeof problemSchema>>().toExtend<Problem>()
  })
})

describe('API_MESSAGES_ES', () => {
  it('trae el mensaje de cada código de error de la API y los de éxito, sin marcadores', () => {
    expect(Object.keys(API_MESSAGES_ES.errors)).toHaveLength(18)
    expect(API_MESSAGES_ES.errors.CAPTCHA_UNAVAILABLE).toBe(
      'No pudimos verificar el captcha en este momento. Inténtalo de nuevo en unos minutos.',
    )
    expect(API_MESSAGES_ES.defaultSuccess).toBe('Operación realizada.')
    expect(API_MESSAGES_ES.success.advanceRequestCreated).toBe('Solicitud recibida.')
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
      // @ts-expect-error la tabla es de solo lectura
      API_MESSAGES_ES.errors.CONFLICT = 'x'
    }
    expect(mutate).toBeTypeOf('function')
  })
})
