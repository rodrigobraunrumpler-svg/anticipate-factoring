import { Logger } from '@nestjs/common'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CaptchaProviderRefusedError } from '#/common/captcha/captcha-verifier.port.js'
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

/** Lo que rechaza `promise`: falla el test si se resuelve. */
async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('se esperaba un rechazo')
}

afterEach(() => {
  vi.restoreAllMocks()
})

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

  it.each([['missing-input-response'], ['invalid-input-response'], ['timeout-or-duplicate']])(
    'el token es el problema (%s): false, sin log de error',
    async (code) => {
      const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
      await expect(
        verifier(replying({ success: false, 'error-codes': [code] })).verify({
          token: 't',
          remoteIp: '1.1.1.1',
        }),
      ).resolves.toBe(false)
      expect(error).not.toHaveBeenCalled()
    },
  )

  it.each([
    [['invalid-input-secret']],
    [['missing-input-secret']],
    [['bad-request']],
    [['internal-error']],
    [['invalid-widget-id']],
    [['invalid-parsed-secret']],
    [['un-codigo-nuevo']],
    [['invalid-input-response', 'invalid-input-secret']],
    [[]],
  ])(
    'Cloudflare rechaza la verificación por su lado o el nuestro (%j): lanza CaptchaProviderRefusedError y registra los códigos con nivel error',
    async (codes) => {
      const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
      const token = 'token-secreto-del-visitante'
      const refused = await refusal(
        verifier(replying({ success: false, 'error-codes': codes })).verify({
          token,
          remoteIp: '203.0.113.7',
          idempotencyKey: KEY,
        }),
      )
      expect(refused).toBeInstanceOf(CaptchaProviderRefusedError)
      expect((refused as CaptchaProviderRefusedError).errorCodes).toEqual(codes)
      expect(error).toHaveBeenCalledTimes(1)
      expect(error).toHaveBeenCalledWith(
        { errorCodes: codes },
        expect.stringContaining('siteverify'),
      )
      const logged = JSON.stringify(error.mock.calls)
      expect(logged).not.toContain(token)
      expect(logged).not.toContain(SECRET)
      expect(logged).not.toContain('203.0.113.7')
    },
  )

  it('sin error-codes en la respuesta también es un rechazo del proveedor, no del token', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const refused = await refusal(
      verifier(replying({ success: false })).verify({ token: 't', remoteIp: '1.1.1.1' }),
    )
    expect(refused).toBeInstanceOf(CaptchaProviderRefusedError)
    expect((refused as CaptchaProviderRefusedError).errorCodes).toEqual([])
  })

  it('acota los códigos que registra: solo el formato de Cloudflare y a lo sumo diez', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const codes = [
      'invalid-input-secret',
      'Con Espacios',
      42,
      'x'.repeat(65),
      ...Array(20).fill('bad-request'),
    ]
    const refused = await refusal(
      verifier(replying({ success: false, 'error-codes': codes })).verify({
        token: 't',
        remoteIp: '1.1.1.1',
      }),
    )
    const expected = [
      'invalid-input-secret',
      'codigo-ilegible',
      'codigo-ilegible',
      'codigo-ilegible',
      ...Array(6).fill('bad-request'),
    ]
    expect((refused as CaptchaProviderRefusedError).errorCodes).toEqual(expected)
    expect(error).toHaveBeenCalledWith({ errorCodes: expected }, expect.any(String))
  })

  it('error-codes que no es una lista: respuesta ilegible (503 CAPTCHA_UNAVAILABLE en el guard)', async () => {
    const refused = await refusal(
      verifier(replying({ success: false, 'error-codes': 'invalid-input-secret' })).verify({
        token: 't',
        remoteIp: '1.1.1.1',
      }),
    )
    expect(refused).not.toBeInstanceOf(CaptchaProviderRefusedError)
    expect(String(refused)).toContain('ilegible')
  })

  it('un token de otro sitio se rechaza y queda un aviso con los dos hostnames', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    await expect(
      verifier(replying({ success: true, hostname: 'otro-sitio.com' }), 'anticipate.pe').verify({
        token: 'token-del-visitante',
        remoteIp: '1.1.1.1',
      }),
    ).resolves.toBe(false)
    expect(warn).toHaveBeenCalledWith(
      { hostname: 'otro-sitio.com', expectedHostname: 'anticipate.pe' },
      expect.any(String),
    )
    expect(JSON.stringify(warn.mock.calls)).not.toContain('token-del-visitante')
  })
})
