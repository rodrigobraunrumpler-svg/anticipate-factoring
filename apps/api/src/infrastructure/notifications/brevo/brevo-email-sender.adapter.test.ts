import { afterEach, describe, expect, it, vi } from 'vitest'
import { PermanentEmailError, RetryableEmailError } from '#/modules/notifications/index.js'
import { BrevoEmailSender } from './brevo-email-sender.adapter.js'

const email = {
  to: { email: 'ana@proveedor.pe', name: 'Ana Pérez' },
  subject: 'Recibimos tu solicitud ANT-2026-000001',
  html: '<p>hola</p>',
  text: 'hola',
  idempotencyKey: '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b',
  tags: ['email.supplier-confirmation'],
}
const sender = new BrevoEmailSender({
  apiKey: 'xkeysib-test',
  fromEmail: 'no-reply@anticipate.pe',
  fromName: 'Anticipate',
  requestTimeoutMs: 20_000,
})
const respond = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers }))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('BrevoEmailSender', () => {
  it('envía con la clave de idempotencia en headers y devuelve el messageId', async () => {
    const fetchMock = respond(201, { messageId: '<abc@smtp-relay.brevo.com>' })
    vi.stubGlobal('fetch', fetchMock)
    await expect(sender.send(email)).resolves.toEqual({
      providerMessageId: '<abc@smtp-relay.brevo.com>',
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.brevo.com/v3/smtp/email')
    expect((init.headers as Record<string, string>)['api-key']).toBe('xkeysib-test')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(init.body as string)).toEqual({
      sender: { email: 'no-reply@anticipate.pe', name: 'Anticipate' },
      to: [{ email: 'ana@proveedor.pe', name: 'Ana Pérez' }],
      subject: email.subject,
      htmlContent: '<p>hola</p>',
      textContent: 'hola',
      headers: { idempotencyKey: email.idempotencyKey },
      tags: ['email.supplier-confirmation'],
    })
  })

  it('sin nombre ni etiquetas manda solo la dirección', async () => {
    const fetchMock = respond(201, { messageId: '<x@brevo>' })
    vi.stubGlobal('fetch', fetchMock)
    await sender.send({ ...email, to: { email: 'equipo@anticipate.pe' }, tags: [] })
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body.to).toEqual([{ email: 'equipo@anticipate.pe' }])
    expect(body).not.toHaveProperty('tags')
  })

  it('429 es reintentable y respeta la espera que pide Brevo', async () => {
    vi.stubGlobal(
      'fetch',
      respond(429, { code: 'too_many_requests', message: 'x' }, { 'x-sib-ratelimit-reset': '42' }),
    )
    const error = await sender.send(email).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RetryableEmailError)
    expect((error as RetryableEmailError).retryAfterSeconds).toBe(42)
  })

  it('5xx y errores de red son reintentables', async () => {
    vi.stubGlobal('fetch', respond(502, {}))
    await expect(sender.send(email)).rejects.toBeInstanceOf(RetryableEmailError)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    await expect(sender.send(email)).rejects.toBeInstanceOf(RetryableEmailError)
  })

  it('otros 4xx son permanentes y el mensaje no repite el cuerpo de Brevo', async () => {
    vi.stubGlobal(
      'fetch',
      respond(400, { code: 'invalid_parameter', message: 'ana@proveedor.pe is not valid' }),
    )
    const error = await sender.send(email).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PermanentEmailError)
    expect((error as Error).message).toBe('Brevo 400 invalid_parameter')
  })
})
