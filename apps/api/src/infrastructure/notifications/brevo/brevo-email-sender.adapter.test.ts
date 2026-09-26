import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EmailAccountError,
  PermanentEmailError,
  RetryableEmailError,
} from '#/modules/notifications/index.js'
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
/** El error con que rechaza `send` ante una respuesta de Brevo. */
async function failureFor(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<unknown> {
  vi.stubGlobal('fetch', respond(status, body, headers))
  return sender.send(email, live()).then(
    () => new Error('se esperaba un rechazo'),
    (error: unknown) => error,
  )
}
/** Una señal que nadie aborta. */
const live = () => new AbortController().signal
/** Un `fetch` que no responde hasta que su señal aborta y entonces rechaza con el motivo, como undici. */
const hangingFetch = () =>
  vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      }),
  )

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('BrevoEmailSender', () => {
  it('envía con la clave de idempotencia en headers y devuelve el messageId', async () => {
    const fetchMock = respond(201, { messageId: '<abc@smtp-relay.brevo.com>' })
    vi.stubGlobal('fetch', fetchMock)
    await expect(sender.send(email, live())).resolves.toEqual({
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
    await sender.send({ ...email, to: { email: 'equipo@anticipate.pe' }, tags: [] }, live())
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body.to).toEqual([{ email: 'equipo@anticipate.pe' }])
    expect(body).not.toHaveProperty('tags')
  })

  it('cualquier 2xx es un envío aceptado: el messageId sale del cuerpo si viene', async () => {
    vi.stubGlobal('fetch', respond(200, { messageId: '<ok@brevo>' }))
    await expect(sender.send(email, live())).resolves.toEqual({ providerMessageId: '<ok@brevo>' })
    vi.stubGlobal('fetch', respond(202, { messageIds: ['<programado@brevo>', '<otro@brevo>'] }))
    await expect(sender.send(email, live())).resolves.toEqual({
      providerMessageId: '<programado@brevo>',
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
    await expect(sender.send(email, live())).resolves.toEqual({ providerMessageId: null })
    vi.stubGlobal('fetch', respond(201, {}))
    await expect(sender.send(email, live())).resolves.toEqual({ providerMessageId: null })
  })

  it('401, 402 y 403 hablan de la cuenta, no del mensaje: se reintentan como EmailAccountError', async () => {
    const cases = [
      { status: 401, code: 'unauthorized', message: 'Key not found' },
      {
        status: 401,
        code: 'unauthorized',
        message: 'We have been unable to recognise the IP address',
      },
      { status: 402, code: 'not_enough_credits', message: 'Not enough credits' },
      { status: 403, code: 'permission_denied', message: 'Unable to send email' },
    ]
    for (const { status, code, message } of cases) {
      const error = await failureFor(status, { code, message })
      expect(error).toBeInstanceOf(EmailAccountError)
      expect(error).toBeInstanceOf(RetryableEmailError)
      expect(error).not.toBeInstanceOf(PermanentEmailError)
      expect((error as Error).message).toBe(`Brevo ${status} ${code}`)
      expect((error as Error).message).not.toContain('xkeysib')
    }
  })

  it('un código de cuenta de Brevo es EmailAccountError aunque llegue con otro 4xx', async () => {
    const error = await failureFor(400, { code: 'account_under_validation', message: 'x' })
    expect(error).toBeInstanceOf(EmailAccountError)
    expect((error as Error).message).toBe('Brevo 400 account_under_validation')
  })

  it('408, 425, 429 y 5xx son pasajeros: reintentables y no de cuenta', async () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      const error = await failureFor(status, {})
      expect(error).toBeInstanceOf(RetryableEmailError)
      expect(error).not.toBeInstanceOf(EmailAccountError)
      expect((error as Error).message).toBe(`Brevo ${status} sin código`)
    }
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    await expect(sender.send(email, live())).rejects.toBeInstanceOf(RetryableEmailError)
  })

  it('un rechazo del mensaje (400, 404, 413, 422) es permanente y el mensaje no repite el cuerpo', async () => {
    const invalid = await failureFor(400, {
      code: 'invalid_parameter',
      message: 'ana@proveedor.pe is not valid',
    })
    expect(invalid).toBeInstanceOf(PermanentEmailError)
    expect((invalid as Error).message).toBe('Brevo 400 invalid_parameter')
    for (const status of [404, 413, 422]) {
      await expect(failureFor(status, { code: 'x' })).resolves.toBeInstanceOf(PermanentEmailError)
    }
  })

  it('un código de Brevo que no es un código (texto libre, una dirección) no llega al mensaje', async () => {
    const error = await failureFor(400, { code: 'ana@proveedor.pe no es válido' })
    expect((error as Error).message).toBe('Brevo 400 sin código')
  })

  describe('espera que pide Brevo', () => {
    const retryAfter = async (status: number, headers: Record<string, string>) =>
      ((await failureFor(status, {}, headers)) as RetryableEmailError).retryAfterSeconds

    afterEach(() => {
      vi.useRealTimers()
    })

    it('429 con x-sib-ratelimit-reset', async () => {
      await expect(retryAfter(429, { 'x-sib-ratelimit-reset': '42' })).resolves.toBe(42)
      await expect(retryAfter(429, { 'x-sib-ratelimit-reset': '1.2' })).resolves.toBe(2)
    })

    it('Retry-After en segundos, en 429 y en 503', async () => {
      await expect(retryAfter(503, { 'retry-after': '120' })).resolves.toBe(120)
      await expect(retryAfter(429, { 'retry-after': '30' })).resolves.toBe(30)
    })

    it('Retry-After como fecha HTTP, medida contra la cabecera Date de la respuesta', async () => {
      await expect(
        retryAfter(503, {
          date: 'Fri, 25 Sep 2026 15:00:00 GMT',
          'retry-after': 'Fri, 25 Sep 2026 15:01:30 GMT',
        }),
      ).resolves.toBe(90)
    })

    it('Retry-After como fecha HTTP sin cabecera Date: contra el reloj local', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-09-25T15:00:00Z'))
      await expect(
        retryAfter(429, { 'retry-after': 'Fri, 25 Sep 2026 15:00:45 GMT' }),
      ).resolves.toBe(45)
    })

    it('con las dos cabeceras vale la espera mayor', async () => {
      await expect(
        retryAfter(429, { 'x-sib-ratelimit-reset': '42', 'retry-after': '60' }),
      ).resolves.toBe(60)
      await expect(
        retryAfter(429, { 'x-sib-ratelimit-reset': '42', 'retry-after': '5' }),
      ).resolves.toBe(42)
    })

    it('una espera ilegible, vencida o ausente no cuenta', async () => {
      await expect(retryAfter(503, { 'retry-after': 'pronto' })).resolves.toBeUndefined()
      await expect(retryAfter(503, { 'retry-after': '-5' })).resolves.toBeUndefined()
      await expect(
        retryAfter(503, {
          date: 'Fri, 25 Sep 2026 15:00:00 GMT',
          'retry-after': 'Fri, 25 Sep 2026 14:59:00 GMT',
        }),
      ).resolves.toBeUndefined()
      await expect(retryAfter(429, { 'x-sib-ratelimit-reset': 'NaN' })).resolves.toBeUndefined()
      await expect(retryAfter(502, {})).resolves.toBeUndefined()
    })
  })

  it('con la señal ya abortada no llama a Brevo y rechaza con el motivo', async () => {
    const fetchMock = respond(201, { messageId: '<x@brevo>' })
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const reason = new Error('tope del handler')
    controller.abort(reason)
    await expect(sender.send(email, controller.signal)).rejects.toBe(reason)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('abortar corta la petición en curso y rechaza con el motivo de la señal', async () => {
    const fetchMock = hangingFetch()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const reason = new Error('tope del handler')
    const sending = sender.send(email, controller.signal)
    controller.abort(reason)
    await expect(sending).rejects.toBe(reason)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.signal?.aborted).toBe(true)
  })

  it('el tope propio corta la petición aunque la señal no avise', async () => {
    vi.stubGlobal('fetch', hangingFetch())
    const quick = new BrevoEmailSender({
      apiKey: 'xkeysib-test',
      fromEmail: 'no-reply@anticipate.pe',
      fromName: 'Anticipate',
      requestTimeoutMs: 30,
    })
    const error = await quick.send(email, live()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RetryableEmailError)
    expect((error as Error).message).toBe('Brevo sin respuesta (TimeoutError)')
  })
})
