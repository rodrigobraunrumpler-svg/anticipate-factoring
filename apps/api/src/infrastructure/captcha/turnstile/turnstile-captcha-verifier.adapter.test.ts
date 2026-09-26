import { describe, expect, it, vi } from 'vitest'
import {
  TURNSTILE_SITEVERIFY_URL,
  TurnstileCaptchaVerifier,
} from './turnstile-captcha-verifier.adapter.js'

const SECRET = '1x0000000000000000000000000000000AA'
const KEY = '0192f3a0-7c1e-7d2a-9b3c-4d5e6f708192'

const replying = (body: unknown, status = 200) =>
  vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status }))

const verifier = (fetchImpl: typeof fetch, expectedHostname?: string) =>
  new TurnstileCaptchaVerifier({ secretKey: SECRET, expectedHostname }, fetchImpl)

describe('TurnstileCaptchaVerifier', () => {
  it('acepta un token válido y manda secreto, token, IP y clave de idempotencia', async () => {
    const fetchImpl = replying({ success: true, hostname: 'localhost' })
    await expect(
      verifier(fetchImpl).verify({ token: 'token', remoteIp: '203.0.113.7', idempotencyKey: KEY }),
    ).resolves.toBe(true)
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe(TURNSTILE_SITEVERIFY_URL)
    expect(JSON.parse(String(init?.body))).toEqual({
      secret: SECRET,
      response: 'token',
      remoteip: '203.0.113.7',
      idempotency_key: KEY,
    })
  })

  it('sin clave de idempotencia no manda el campo', async () => {
    const fetchImpl = replying({ success: true })
    await verifier(fetchImpl).verify({ token: 'token', remoteIp: '203.0.113.7' })
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).not.toHaveProperty(
      'idempotency_key',
    )
  })

  it('rechaza un token inválido, y uno vacío o demasiado largo sin llamar a Cloudflare', async () => {
    const invalid = replying({ success: false, 'error-codes': ['invalid-input-response'] })
    await expect(verifier(invalid).verify({ token: 'malo', remoteIp: '1.1.1.1' })).resolves.toBe(
      false,
    )
    const untouched = vi.fn<typeof fetch>()
    await expect(verifier(untouched).verify({ token: '', remoteIp: '1.1.1.1' })).resolves.toBe(
      false,
    )
    await expect(
      verifier(untouched).verify({ token: 'x'.repeat(2049), remoteIp: '1.1.1.1' }),
    ).resolves.toBe(false)
    expect(untouched).not.toHaveBeenCalled()
  })

  it('con hostname esperado, rechaza un token emitido para otro sitio', async () => {
    const other = replying({ success: true, hostname: 'otro-sitio.com' })
    await expect(
      verifier(other, 'anticipate.pe').verify({ token: 't', remoteIp: '1.1.1.1' }),
    ).resolves.toBe(false)
  })

  it('lanza si Cloudflare no responde, responde con error o devuelve algo ilegible', async () => {
    const down = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'))
    await expect(verifier(down).verify({ token: 't', remoteIp: '1.1.1.1' })).rejects.toThrow()
    await expect(
      verifier(replying({ success: true }, 500)).verify({ token: 't', remoteIp: '1.1.1.1' }),
    ).rejects.toThrow('Turnstile respondió 500')
    await expect(
      verifier(replying({ ok: 'raro' })).verify({ token: 't', remoteIp: '1.1.1.1' }),
    ).rejects.toThrow('ilegible')
  })
})
