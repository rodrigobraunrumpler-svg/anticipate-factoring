import { API_ERROR_MESSAGES_ES } from '@anticipate/shared/api'
import { createProblem } from '@anticipate/shared/errors'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { ApiError, apiError } from './api-error.js'
import {
  ApiValidationError,
  MAX_MESSAGES_PER_FIELD,
  MAX_VALIDATION_VIOLATIONS,
  VALIDATION_ROOT_FIELD,
} from './api-validation.error.js'
import { isApplicationError } from './application-error.js'
import { ApplicationErrorCategory } from './application-error-category.js'
import { BusinessRulesViolatedError } from './business-rules-violated.error.js'
import { ServiceUnavailableError } from './service-unavailable.error.js'

describe('apiError', () => {
  it('crea un error público sin detalle con el mensaje del código', () => {
    const cause = new Error('timeout')
    const error = apiError('CAPTCHA_UNAVAILABLE', 'siteverify no respondió', { cause })
    expect(error).toBeInstanceOf(ApiError)
    expect(isApplicationError(error)).toBe(true)
    expect(error.publicCode).toBe('CAPTCHA_UNAVAILABLE')
    expect(error.category).toBe(ApplicationErrorCategory.SERVICE_UNAVAILABLE)
    expect(error.publicMessage).toBe(API_ERROR_MESSAGES_ES.CAPTCHA_UNAVAILABLE)
    expect(error.message).toBe('siteverify no respondió')
    expect(error.cause).toBe(cause)
    expect(error).not.toHaveProperty('publicDetails')
  })

  it('acepta un mensaje público propio, como el de un tope con su valor', () => {
    const error = apiError('TOO_MANY_FILES', 'multer: LIMIT_FILE_COUNT', {
      publicMessage: 'Puedes enviar hasta 20 archivos.',
    })
    expect(error.publicCode).toBe('TOO_MANY_FILES')
    expect(error.publicMessage).toBe('Puedes enviar hasta 20 archivos.')
    expect(error.message).toBe('multer: LIMIT_FILE_COUNT')
    expect(() => apiError('TOO_MANY_FILES', undefined, { publicMessage: '  ' })).toThrow(TypeError)
  })

  it('no acepta los códigos que llevan detalle', () => {
    // @ts-expect-error VALIDATION_ERROR se lanza con ApiValidationError
    expect(() => apiError('VALIDATION_ERROR')).toThrow(TypeError)
    // @ts-expect-error BUSINESS_RULES_VIOLATED se lanza con BusinessRulesViolatedError
    expect(() => apiError('BUSINESS_RULES_VIOLATED')).toThrow(TypeError)
  })
})

describe('ApiValidationError', () => {
  it('agrupa por campo en orden de aparición y quita mensajes repetidos', () => {
    const error = new ApiValidationError([
      { field: 'contact.email', messages: ['El correo no es válido.'] },
      { field: 'contact.mobile', messages: ['El celular debe tener 9 dígitos y empezar con 9.'] },
      { field: ' contact.email ', messages: ['El correo no es válido.', 'Otro mensaje.'] },
    ])
    expect(error.publicCode).toBe('VALIDATION_ERROR')
    expect(error.category).toBe(ApplicationErrorCategory.BAD_REQUEST)
    expect(error.violations).toEqual([
      { field: 'contact.email', messages: ['El correo no es válido.', 'Otro mensaje.'] },
      { field: 'contact.mobile', messages: ['El celular debe tener 9 dígitos y empezar con 9.'] },
    ])
    expect(error.publicDetails).toEqual({ violations: error.violations })
  })

  it('una lista vacía produce una observación genérica y no lanza', () => {
    expect(new ApiValidationError([]).violations).toEqual([
      { field: VALIDATION_ROOT_FIELD, messages: [API_ERROR_MESSAGES_ES.VALIDATION_ERROR] },
    ])
  })

  it('corrige entradas inválidas en vez de lanzar', () => {
    const error = new ApiValidationError([
      { field: '', messages: ['Falta el cuerpo.'] },
      { field: 42, messages: 'no es arreglo' },
      { field: 'form', messages: ['', 3, 'El formulario no es JSON.'] },
      null as never,
    ])
    expect(error.violations).toEqual([
      { field: VALIDATION_ROOT_FIELD, messages: ['Falta el cuerpo.'] },
      { field: 'form', messages: ['El formulario no es JSON.'] },
    ])
  })

  it('acota la cantidad de campos, de mensajes y el largo de cada texto', () => {
    const many = Array.from({ length: MAX_VALIDATION_VIOLATIONS + 10 }, (_, index) => ({
      field: `campo${index}`,
      messages: Array.from({ length: MAX_MESSAGES_PER_FIELD + 5 }, (_, n) => `Mensaje ${n}.`),
    }))
    const error = new ApiValidationError([
      ...many,
      { field: 'x'.repeat(1000), messages: ['y'.repeat(5000)] },
    ])
    expect(error.violations).toHaveLength(MAX_VALIDATION_VIOLATIONS)
    expect(error.violations[0]?.messages).toHaveLength(MAX_MESSAGES_PER_FIELD)
    const long = new ApiValidationError([{ field: 'x'.repeat(1000), messages: ['y'.repeat(5000)] }])
    expect(long.violations[0]?.field).toHaveLength(256)
    expect(long.violations[0]?.messages[0]).toHaveLength(1000)
  })

  it('nunca lanza y siempre deja observaciones válidas, para cualquier entrada', () => {
    fc.assert(
      fc.property(fc.array(fc.anything()), (input) => {
        const { violations } = new ApiValidationError(input as never)
        expect(violations.length).toBeGreaterThan(0)
        expect(violations.length).toBeLessThanOrEqual(MAX_VALIDATION_VIOLATIONS)
        for (const violation of violations) {
          expect(violation.field.trim()).not.toBe('')
          expect(violation.messages.length).toBeGreaterThan(0)
          for (const message of violation.messages) expect(message.trim()).not.toBe('')
        }
      }),
    )
  })
})

describe('BusinessRulesViolatedError', () => {
  it('lleva todos los problemas congelados en details.problems', () => {
    const problems = [
      createProblem('NO_INVOICES'),
      createProblem('TOO_MANY_INVOICES', { data: { max: 10 } }),
    ]
    const error = new BusinessRulesViolatedError(problems)
    expect(error.publicCode).toBe('BUSINESS_RULES_VIOLATED')
    expect(error.category).toBe(ApplicationErrorCategory.UNPROCESSABLE_ENTITY)
    expect(error.problems).toEqual(problems)
    expect(Object.isFrozen(error.problems)).toBe(true)
  })

  it('una lista vacía es un error de programación', () => {
    expect(() => new BusinessRulesViolatedError([])).toThrow(TypeError)
  })
})

describe('ServiceUnavailableError', () => {
  it('es 503 con el mensaje en español y deja el diagnóstico y la causa para los logs', () => {
    const cause = new Error('socket hang up')
    const error = new ServiceUnavailableError('S3 no respondió', { cause })
    expect(error.publicCode).toBe('SERVICE_UNAVAILABLE')
    expect(error.category).toBe(ApplicationErrorCategory.SERVICE_UNAVAILABLE)
    expect(error.publicMessage).toBe(API_ERROR_MESSAGES_ES.SERVICE_UNAVAILABLE)
    expect(error.message).toBe('S3 no respondió')
    expect(error.cause).toBe(cause)
  })
})
