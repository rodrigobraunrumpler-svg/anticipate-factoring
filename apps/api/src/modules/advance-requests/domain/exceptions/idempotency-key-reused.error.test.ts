import { API_ERROR_MESSAGES_ES } from '@anticipate/shared/api'
import { describe, expect, it } from 'vitest'
import { isApplicationError } from '#/common/exceptions/index.js'
import { IdempotencyKeyReusedError } from './idempotency-key-reused.error.js'

const KEY = '0199a3b4-c5da-7d77-8e88-9f0a1b2c3d4e'

describe('IdempotencyKeyReusedError', () => {
  it('es un error de aplicación 422 con el código y el mensaje del contrato', () => {
    const error = new IdempotencyKeyReusedError(KEY)
    expect(isApplicationError(error)).toBe(true)
    expect(error.name).toBe('IdempotencyKeyReusedError')
    expect(error.publicCode).toBe('IDEMPOTENCY_KEY_REUSED')
    expect(error.category).toBe('UNPROCESSABLE_ENTITY')
    expect(error.publicMessage).toBe(API_ERROR_MESSAGES_ES.IDEMPOTENCY_KEY_REUSED)
    expect(error.publicDetails).toBeUndefined()
  })

  it('la clave queda en el diagnóstico para el log, nunca en el mensaje público', () => {
    const error = new IdempotencyKeyReusedError(KEY)
    expect(error.message).toBe(`Idempotency-Key ${KEY} reutilizada con otra huella`)
    expect(error.publicMessage).not.toContain(KEY)
  })
})
