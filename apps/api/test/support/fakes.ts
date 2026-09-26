import type { CaptchaVerificationInput, CaptchaVerifierPort } from '#/common/captcha/index.js'
import type { Clock } from '#/common/time/clock.js'

/** Reloj de prueba: queda fijo hasta que el test lo mueve. */
export class MutableClock implements Clock {
  private current: number

  constructor(start: Date) {
    this.current = start.getTime()
  }

  now(): Date {
    return new Date(this.current)
  }

  set(date: Date): void {
    this.current = date.getTime()
  }

  advance(milliseconds: number): void {
    this.current += milliseconds
  }
}

/** Captcha de prueba: aprueba o rechaza a pedido, cuenta las llamadas y guarda la última clave. */
export class FakeCaptchaVerifier implements CaptchaVerifierPort {
  valid = true
  unavailable = false
  calls = 0
  lastIdempotencyKey: string | undefined

  async verify(input: CaptchaVerificationInput): Promise<boolean> {
    this.calls++
    this.lastIdempotencyKey = input.idempotencyKey
    if (this.unavailable) throw new Error('captcha de prueba sin respuesta')
    return this.valid
  }

  reset(): void {
    this.valid = true
    this.unavailable = false
    this.calls = 0
    this.lastIdempotencyKey = undefined
  }
}
