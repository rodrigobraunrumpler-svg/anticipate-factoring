import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { createProblem } from '../errors/index.js'
import {
  type ApiErrorEnvelope,
  type ApiSuccessEnvelope,
  apiErrorEnvelopeSchema,
  apiSuccessEnvelopeSchema,
  CORRELATION_ID_PATTERN,
  cursorMetaSchema,
  paginationMetaSchema,
  validationViolationSchema,
} from './envelopes.js'
import {
  API_ERROR_CODES,
  API_ERROR_HTTP_STATUS,
  API_ERROR_MESSAGES_ES,
  type ApiErrorCode,
} from './error-codes.js'

const common = {
  correlationId: 'b3c1f0e2-4d5a-4b6c-8d7e-9f0a1b2c3d4e',
  timestamp: '2026-09-24T15:04:05.000Z',
}

const item = z.object({ n: z.number() })
const one = apiSuccessEnvelopeSchema(item)
const list = apiSuccessEnvelopeSchema(z.array(item))

const success = {
  success: true,
  statusCode: 200,
  message: 'Operación realizada.',
  data: { n: 1 },
  ...common,
}
const pagination = {
  totalCount: 3,
  pageCount: 2,
  currentPage: 1,
  isFirstPage: true,
  isLastPage: false,
  previousPage: null,
  nextPage: 2,
}

describe('apiSuccessEnvelopeSchema', () => {
  it('acepta el sobre estándar y valida data con el esquema del endpoint', () => {
    expect(one.parse(success)).toEqual(success)
    expect(one.safeParse({ ...success, data: { n: 'uno' } }).success).toBe(false)
    expect(one.safeParse({ ...success, statusCode: 201 }).success).toBe(true)
  })

  it('acepta una lista con metadataPagination o con metadataCursor', () => {
    const page = { ...success, data: [{ n: 1 }], metadataPagination: pagination }
    const cursor = {
      ...success,
      data: [{ n: 1 }],
      metadataCursor: { nextCursor: 'abc', hasNext: true },
    }
    expect(list.parse(page)).toEqual(page)
    expect(list.parse(cursor)).toEqual(cursor)
  })

  it('rechaza las dos metadatas a la vez y la metadata sobre algo que no es una lista', () => {
    const both = {
      ...success,
      data: [],
      metadataPagination: pagination,
      metadataCursor: { nextCursor: null, hasNext: false },
    }
    expect(list.safeParse(both).success).toBe(false)
    const notAList = { ...success, metadataCursor: { nextCursor: null, hasNext: false } }
    expect(one.safeParse(notAList).success).toBe(false)
  })

  it('rechaza lo que no es el sobre: propiedad de más, estado que no es 2xx, sin correlationId o timestamp inválido', () => {
    for (const bad of [
      { ...success, error: 'Bad Request' },
      { ...success, success: false },
      { ...success, statusCode: 400 },
      { ...success, statusCode: 200.5 },
      { ...success, message: '' },
      { ...success, correlationId: '' },
      { ...success, correlationId: 'con espacio' },
      { ...success, timestamp: '24/09/2026' },
      { ...success, metadataPagination: undefined },
    ]) {
      expect(one.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('su salida es un ApiSuccessEnvelope del dato del endpoint', () => {
    expectTypeOf<z.output<typeof one>>().toEqualTypeOf<ApiSuccessEnvelope<{ n: number }>>()
    expectTypeOf<z.output<typeof list>['data']>().toEqualTypeOf<{ n: number }[]>()
  })
})

describe('metadatas y violaciones', () => {
  it('paginationMetaSchema: enteros, página desde 1', () => {
    expect(paginationMetaSchema.parse(pagination)).toEqual(pagination)
    const empty = { ...pagination, totalCount: 0, pageCount: 0, isLastPage: true, nextPage: null }
    expect(paginationMetaSchema.parse(empty)).toEqual(empty)
    expect(paginationMetaSchema.safeParse({ ...pagination, currentPage: 0 }).success).toBe(false)
    expect(paginationMetaSchema.safeParse({ ...pagination, totalCount: 1.5 }).success).toBe(false)
  })

  it('cursorMetaSchema: hasNext si y solo si hay nextCursor', () => {
    expect(cursorMetaSchema.safeParse({ nextCursor: 'abc', hasNext: true }).success).toBe(true)
    expect(cursorMetaSchema.safeParse({ nextCursor: null, hasNext: false }).success).toBe(true)
    expect(cursorMetaSchema.safeParse({ nextCursor: 'abc', hasNext: false }).success).toBe(false)
    expect(cursorMetaSchema.safeParse({ nextCursor: null, hasNext: true }).success).toBe(false)
    expect(cursorMetaSchema.safeParse({ nextCursor: '', hasNext: true }).success).toBe(false)
  })

  it('validationViolationSchema: ruta con puntos (vacía en la raíz) y al menos un mensaje', () => {
    const violation = { field: 'contact.email', messages: ['El correo no es válido.'] }
    expect(validationViolationSchema.parse(violation)).toEqual(violation)
    expect(validationViolationSchema.safeParse({ field: '', messages: ['m'] }).success).toBe(true)
    expect(validationViolationSchema.safeParse({ field: 'x', messages: [] }).success).toBe(false)
    expect(validationViolationSchema.safeParse({ field: 'x', messages: [''] }).success).toBe(false)
  })
})

const errorOf = (code: ApiErrorCode) => ({
  success: false,
  statusCode: API_ERROR_HTTP_STATUS[code],
  code,
  message: API_ERROR_MESSAGES_ES[code],
  ...common,
})

describe('apiErrorEnvelopeSchema', () => {
  it('todo código sin detalle es un sobre válido con su estado', () => {
    for (const code of API_ERROR_CODES) {
      if (code === 'VALIDATION_ERROR' || code === 'BUSINESS_RULES_VIOLATED') continue
      expect(apiErrorEnvelopeSchema.safeParse(errorOf(code)).success, code).toBe(true)
    }
  })

  it('VALIDATION_ERROR lleva violations y BUSINESS_RULES_VIOLATED lleva problems', () => {
    const validation = {
      ...errorOf('VALIDATION_ERROR'),
      details: { violations: [{ field: 'contact.email', messages: ['El correo no es válido.'] }] },
    }
    const rules = {
      ...errorOf('BUSINESS_RULES_VIOLATED'),
      details: {
        problems: [
          createProblem('ISSUE_DATE_IN_FUTURE', { invoice: 'F001-1', data: { invoice: 'F001-1' } }),
          createProblem('INVALID_PDF', { file: 'F001-1.pdf', data: { file: 'F001-1.pdf' } }),
        ],
      },
    }
    expect(apiErrorEnvelopeSchema.parse(validation)).toEqual(validation)
    expect(apiErrorEnvelopeSchema.parse(rules)).toEqual(rules)
  })

  it('rechaza details que no corresponden al código, vacíos o ausentes', () => {
    const violations = { violations: [{ field: 'x', messages: ['m'] }] }
    const problems = { problems: [createProblem('NO_INVOICES')] }
    for (const bad of [
      { ...errorOf('VALIDATION_ERROR') },
      { ...errorOf('VALIDATION_ERROR'), details: problems },
      { ...errorOf('VALIDATION_ERROR'), details: { violations: [] } },
      { ...errorOf('BUSINESS_RULES_VIOLATED'), details: violations },
      { ...errorOf('BUSINESS_RULES_VIOLATED'), details: { problems: [] } },
      { ...errorOf('BAD_REQUEST'), details: violations },
      { ...errorOf('INTERNAL_ERROR'), details: problems },
    ]) {
      expect(apiErrorEnvelopeSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('BAD_REQUEST admite cualquier 4xx y INTERNAL_ERROR cualquier 5xx: la reserva para excepciones HTTP sin código propio', () => {
    for (const statusCode of [403, 405, 415, 422]) {
      const envelope = { ...errorOf('BAD_REQUEST'), statusCode }
      expect(apiErrorEnvelopeSchema.safeParse(envelope).success, String(statusCode)).toBe(true)
    }
    for (const statusCode of [501, 502, 504]) {
      const envelope = { ...errorOf('INTERNAL_ERROR'), statusCode }
      expect(apiErrorEnvelopeSchema.safeParse(envelope).success, String(statusCode)).toBe(true)
    }
  })

  it('rechaza un estado ajeno al código, un código desconocido o una propiedad de más', () => {
    const problem = createProblem('NO_INVOICES')
    for (const bad of [
      { ...errorOf('CAPTCHA_FAILED'), statusCode: 400 },
      { ...errorOf('SERVICE_UNAVAILABLE'), statusCode: 500 },
      { ...errorOf('BUSINESS_RULES_VIOLATED'), statusCode: 400, details: { problems: [problem] } },
      { ...errorOf('BAD_REQUEST'), statusCode: 500 },
      { ...errorOf('BAD_REQUEST'), statusCode: 399 },
      { ...errorOf('INTERNAL_ERROR'), statusCode: 400 },
      { ...errorOf('INTERNAL_ERROR'), statusCode: 600 },
      { ...errorOf('BAD_REQUEST'), code: 'Bad Request' },
      { ...errorOf('BAD_REQUEST'), error: 'Bad Request' },
      { ...errorOf('INTERNAL_ERROR'), stack: 'Error: boom' },
      { ...errorOf('BAD_REQUEST'), success: true },
      { ...errorOf('BAD_REQUEST'), message: '' },
    ]) {
      expect(apiErrorEnvelopeSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('su salida es un ApiErrorEnvelope', () => {
    expectTypeOf<z.output<typeof apiErrorEnvelopeSchema>>().toExtend<ApiErrorEnvelope>()
  })
})

describe('CORRELATION_ID_PATTERN', () => {
  it('acepta un UUID y los caracteres seguros, hasta 128', () => {
    expect(CORRELATION_ID_PATTERN.test(common.correlationId)).toBe(true)
    expect(CORRELATION_ID_PATTERN.test('req_1.a-B')).toBe(true)
    expect(CORRELATION_ID_PATTERN.test('a'.repeat(128))).toBe(true)
  })

  it('rechaza vacío, más de 128, espacios, saltos de línea y caracteres de control', () => {
    for (const value of ['', 'a'.repeat(129), 'a b', 'a\nb', 'a\u0000b', '<script>']) {
      expect(CORRELATION_ID_PATTERN.test(value), JSON.stringify(value)).toBe(false)
    }
  })
})
