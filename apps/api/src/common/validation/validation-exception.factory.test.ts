import { API_ERROR_MESSAGES_ES } from '@anticipate/shared/api'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ApiValidationError } from '#/common/exceptions/index.js'
import { issueField, validationExceptionFactory } from './validation-exception.factory.js'

describe('issueField', () => {
  it.each([
    [{ message: 'x' }, ''],
    [{ message: 'x', path: [] }, ''],
    [{ message: 'x', path: ['contact', 'email'] }, 'contact.email'],
    [{ message: 'x', path: [{ key: 'invoices' }, { key: 0 }, 'total'] }, 'invoices.0.total'],
    [{ message: 'x', path: [Symbol('meta'), 'a'] }, 'meta.a'],
  ])('%o → "%s"', (issue, field) => {
    expect(issueField(issue)).toBe(field)
  })
})

describe('validationExceptionFactory', () => {
  it('agrupa los issues por ruta en un ApiValidationError', () => {
    const error = validationExceptionFactory([
      { message: 'El correo no es válido.', path: ['contact', 'email'] },
      { message: 'El correo no puede tener más de 254 caracteres.', path: ['contact', 'email'] },
      { message: 'Revisa el cuerpo.' },
    ])
    expect(error).toBeInstanceOf(ApiValidationError)
    expect(error.violations).toEqual([
      {
        field: 'contact.email',
        messages: ['El correo no es válido.', 'El correo no puede tener más de 254 caracteres.'],
      },
      { field: '$', messages: ['Revisa el cuerpo.'] },
    ])
  })

  it('sin issues deja la observación genérica', () => {
    expect(validationExceptionFactory([]).violations).toEqual([
      { field: '$', messages: [API_ERROR_MESSAGES_ES.VALIDATION_ERROR] },
    ])
  })

  it('traduce los issues reales de un esquema Zod con sus mensajes', async () => {
    const schema = z.object({
      name: z.string({ error: 'Escribe tu nombre.' }).min(3, { error: 'El nombre es muy corto.' }),
      tags: z.array(z.string({ error: 'Cada etiqueta es texto.' })),
    })
    const result = await schema['~standard'].validate({ name: 'Al', tags: ['a', 3] })
    expect(result.issues).toBeDefined()
    const error = validationExceptionFactory(result.issues ?? [])
    expect(error.violations).toEqual([
      { field: 'name', messages: ['El nombre es muy corto.'] },
      { field: 'tags.1', messages: ['Cada etiqueta es texto.'] },
    ])
  })
})
