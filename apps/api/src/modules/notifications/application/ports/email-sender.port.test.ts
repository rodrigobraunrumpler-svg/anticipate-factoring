import { describe, expect, it } from 'vitest'
import { EmailAccountError, PermanentEmailError, RetryableEmailError } from './email-sender.port.js'

describe('errores del envío de correo', () => {
  it('RetryableEmailError guarda la espera que pidió el proveedor', () => {
    expect(new RetryableEmailError('Brevo 429 sin código', 42).retryAfterSeconds).toBe(42)
    expect(new RetryableEmailError('Brevo 503 sin código', 0).retryAfterSeconds).toBe(0)
    expect(new RetryableEmailError('Brevo 502 sin código').retryAfterSeconds).toBeUndefined()
  })

  it('una espera que no es un número finito y no negativo se descarta, sin lanzar', () => {
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
      const error = new RetryableEmailError('Brevo 429 sin código', invalid)
      expect(error.retryAfterSeconds).toBeUndefined()
      expect(error.message).toBe('Brevo 429 sin código')
    }
  })

  it('EmailAccountError es reintentable, no permanente, y conserva su nombre', () => {
    const error = new EmailAccountError('Brevo 401 unauthorized')
    expect(error).toBeInstanceOf(RetryableEmailError)
    expect(error).not.toBeInstanceOf(PermanentEmailError)
    expect(error.name).toBe('EmailAccountError')
    expect(error.retryAfterSeconds).toBeUndefined()
    expect(new EmailAccountError('Brevo 403 permission_denied', 60).retryAfterSeconds).toBe(60)
  })
})
