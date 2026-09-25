import {
  API_ERROR_CODES,
  API_ERROR_HTTP_STATUS,
  API_ERROR_MESSAGES_ES,
  type ApiErrorCode,
} from '@anticipate/shared/api'
import { describe, expect, it } from 'vitest'
import {
  ApplicationError,
  type ApplicationErrorOptions,
  isApplicationError,
} from './application-error.js'
import {
  ApplicationErrorCategory,
  applicationErrorCategoryOf,
} from './application-error-category.js'

/** Subclase mínima para probar la base abstracta con cualquier código. */
class ProbeError extends ApplicationError<ApiErrorCode, object> {
  constructor(code: ApiErrorCode, options: ApplicationErrorOptions<object> = {}) {
    super(code, options)
  }
}

const CATEGORY_BY_STATUS: Record<number, ApplicationErrorCategory> = {
  400: ApplicationErrorCategory.BAD_REQUEST,
  403: ApplicationErrorCategory.FORBIDDEN,
  404: ApplicationErrorCategory.NOT_FOUND,
  409: ApplicationErrorCategory.CONFLICT,
  411: ApplicationErrorCategory.LENGTH_REQUIRED,
  413: ApplicationErrorCategory.PAYLOAD_TOO_LARGE,
  422: ApplicationErrorCategory.UNPROCESSABLE_ENTITY,
  429: ApplicationErrorCategory.RATE_LIMIT,
  500: ApplicationErrorCategory.INTERNAL,
  503: ApplicationErrorCategory.SERVICE_UNAVAILABLE,
}

describe('applicationErrorCategoryOf', () => {
  it.each(API_ERROR_CODES)('%s tiene la categoría de su estado HTTP', (code) => {
    expect(applicationErrorCategoryOf(code)).toBe(CATEGORY_BY_STATUS[API_ERROR_HTTP_STATUS[code]])
  })
})

describe('ApplicationError', () => {
  it('toma el mensaje en español del código y lo usa también como mensaje interno', () => {
    const error = new ProbeError('CONFLICT')
    expect(error.publicCode).toBe('CONFLICT')
    expect(error.category).toBe(ApplicationErrorCategory.CONFLICT)
    expect(error.publicMessage).toBe(API_ERROR_MESSAGES_ES.CONFLICT)
    expect(error.message).toBe(API_ERROR_MESSAGES_ES.CONFLICT)
    expect(error.name).toBe('ProbeError')
    expect(error).not.toHaveProperty('publicDetails')
  })

  it('acepta un mensaje público propio', () => {
    expect(new ProbeError('CONFLICT', { publicMessage: 'Otro texto.' }).publicMessage).toBe(
      'Otro texto.',
    )
  })

  it('guarda el diagnóstico y la causa solo del lado privado', () => {
    const cause = new Error('connect ECONNREFUSED 127.0.0.1:5432')
    const error = new ProbeError('SERVICE_UNAVAILABLE', {
      diagnostic: 'la base no respondió',
      cause,
    })
    expect(error.message).toBe('la base no respondió')
    expect(error.cause).toBe(cause)
    expect(error.publicMessage).toBe(API_ERROR_MESSAGES_ES.SERVICE_UNAVAILABLE)
  })

  it('rechaza un código desconocido y un mensaje público vacío', () => {
    expect(() => new ProbeError('NO_EXISTE' as ApiErrorCode)).toThrow(TypeError)
    expect(() => new ProbeError('CONFLICT', { publicMessage: '   ' })).toThrow(TypeError)
  })

  it('copia los detalles en profundidad y los congela', () => {
    const details = { items: [{ name: 'a' }], meta: { total: 1 } }
    const error = new ProbeError('CONFLICT', { details })
    details.items.push({ name: 'b' })
    details.meta.total = 2
    expect(error.publicDetails).toEqual({ items: [{ name: 'a' }], meta: { total: 1 } })
    expect(Object.isFrozen(error.publicDetails)).toBe(true)
    expect(Object.isFrozen((error.publicDetails as { items: object[] }).items[0])).toBe(true)
  })

  it('quita las propiedades undefined como JSON y nunca lanza por eso', () => {
    const error = new ProbeError('CONFLICT', {
      details: {
        kept: 1,
        dropped: undefined,
        nested: { gone: undefined, here: 'x' },
        list: [1, undefined],
        nan: Number.NaN,
      },
    })
    expect(error.publicDetails).toEqual({
      kept: 1,
      nested: { here: 'x' },
      list: [1, null],
      nan: null,
    })
    expect(error.publicDetails).not.toHaveProperty('dropped')
  })

  it('acepta objetos sin prototipo', () => {
    const details = Object.assign(Object.create(null) as object, { form: 'x' })
    expect(new ProbeError('CONFLICT', { details }).publicDetails).toEqual({ form: 'x' })
  })

  it.each([
    ['una fecha', { at: new Date(0) }],
    ['una función', { run: () => 1 }],
    ['un bigint', { big: 1n }],
    ['una clave símbolo', { [Symbol('x')]: 1 }],
    ['una clave rara', { 'mala clave': 1 }],
    ['un accesor', Object.defineProperty({}, 'lazy', { get: () => 1, enumerable: true })],
    ['un arreglo en la raíz', [1, 2]],
  ])('lanza TypeError si los detalles traen %s', (_label, details) => {
    expect(() => new ProbeError('CONFLICT', { details })).toThrow(TypeError)
  })

  it('lanza TypeError ante un ciclo', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => new ProbeError('CONFLICT', { details: cyclic })).toThrow(TypeError)
  })

  it('sus propiedades públicas son de solo lectura', () => {
    const error = new ProbeError('CONFLICT', { details: { a: 1 } })
    expect(() => {
      Object.assign(error, { publicCode: 'BAD_REQUEST' })
    }).toThrow(TypeError)
    expect(error.publicCode).toBe('CONFLICT')
  })
})

describe('isApplicationError', () => {
  it('reconoce solo errores construidos por ApplicationError', () => {
    const real = new ProbeError('CONFLICT')
    const lookalike = Object.create(ProbeError.prototype) as object
    const plain = { publicCode: 'CONFLICT', publicMessage: 'x', category: 'CONFLICT' }
    expect(isApplicationError(real)).toBe(true)
    expect(isApplicationError(lookalike)).toBe(false)
    expect(isApplicationError(plain)).toBe(false)
    expect(isApplicationError(new Error('x'))).toBe(false)
    expect(isApplicationError(undefined)).toBe(false)
  })
})
