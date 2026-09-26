import { decodeXml, parseUblInvoice } from '@anticipate/shared/invoice'
import type { CaptchaVerificationInput, CaptchaVerifierPort } from '#/common/captcha/index.js'
import type { Clock } from '#/common/time/clock.js'
import type {
  InvoiceXmlParseOutcome,
  InvoiceXmlParserPort,
} from '#/modules/advance-requests/index.js'

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

/**
 * Lector de XML de prueba: la misma lectura que el worker de producción
 * (`parseUblInvoice(decodeXml(bytes), { maxLength })`), pero en el mismo hilo y cediendo el turno
 * como uno real. Registra cada llamada y cuántas hubo a la vez; `outcomes` reemplaza la respuesta de
 * una llamada por su número (desde 0), y un `Error` la rechaza.
 */
export class InlineInvoiceXmlParser implements InvoiceXmlParserPort {
  readonly calls: { xml: Uint8Array; maxLength: number }[] = []
  readonly outcomes = new Map<number, InvoiceXmlParseOutcome | Error>()
  maxConcurrent = 0
  private active = 0

  async parse(
    xml: Uint8Array,
    {
      maxLength,
      signal,
    }: { readonly maxLength: number; readonly signal?: AbortSignal | undefined },
  ): Promise<InvoiceXmlParseOutcome> {
    signal?.throwIfAborted()
    const index = this.calls.push({ xml, maxLength }) - 1
    this.active += 1
    this.maxConcurrent = Math.max(this.maxConcurrent, this.active)
    try {
      await new Promise((resolve) => setImmediate(resolve))
      const outcome = this.outcomes.get(index)
      if (outcome instanceof Error) throw outcome
      return outcome ?? { status: 'parsed', result: parseUblInvoice(decodeXml(xml), { maxLength }) }
    } finally {
      this.active -= 1
    }
  }
}
