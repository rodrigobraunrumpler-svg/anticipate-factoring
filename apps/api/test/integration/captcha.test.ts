import { apiErrorEnvelopeSchema } from '@anticipate/shared/api'
import { Logger } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CAPTCHA_VERIFIER } from '#/common/captcha/index.js'
import { CORRELATION_ID_HEADER } from '#/common/constants/http-headers.constants.js'
import { TurnstileCaptchaVerifier } from '#/infrastructure/captcha/turnstile/index.js'
import { submitAdvanceRequest } from '../support/advance-request-fixtures.js'
import { createTestApp } from '../support/app.js'

/** Secreto de prueba: nunca debe aparecer en un log ni en una respuesta. */
const SECRET = 'secreto-rotado-0000000000000000000000'
const TOKEN = 'token-del-visitante-que-no-se-registra'

/**
 * `fetch` de siteverify reemplazado: el test nunca llama a Cloudflare. Cada caso fija la respuesta.
 */
const siteverify = vi.fn<typeof fetch>()
const replying = (body: unknown) =>
  siteverify.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }))

describe('POST /api/v1/advance-requests con el adaptador real de Turnstile', () => {
  let app: NestExpressApplication

  beforeAll(async () => {
    app = await createTestApp({
      overrides: [
        [
          CAPTCHA_VERIFIER,
          new TurnstileCaptchaVerifier(
            { secretKey: SECRET, expectedHostname: undefined },
            (...args) => siteverify(...args),
          ),
        ],
      ],
    })
  })

  afterEach(() => {
    siteverify.mockReset()
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    await app.close()
  })

  it.each(['invalid-input-secret', 'missing-input-secret', 'bad-request', 'internal-error'])(
    'siteverify responde %s: 503 SERVICE_UNAVAILABLE sin caché y log de error con el código, sin token ni secreto',
    async (code) => {
      const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
      replying({ success: false, 'error-codes': [code] })

      const res = await submitAdvanceRequest(app, { token: TOKEN })

      expect(res.status, JSON.stringify(res.body)).toBe(503)
      const body = apiErrorEnvelopeSchema.parse(res.body)
      expect(body.code).toBe('SERVICE_UNAVAILABLE')
      expect(res.headers['cache-control']).toBe('no-store')
      expect(res.headers[CORRELATION_ID_HEADER]).toBe(body.correlationId)
      expect(error).toHaveBeenCalledWith(
        { errorCodes: [code] },
        expect.stringContaining('siteverify'),
      )
      const logged = JSON.stringify(error.mock.calls)
      expect(logged).not.toContain(TOKEN)
      expect(logged).not.toContain(SECRET)
      expect(JSON.stringify(res.body)).not.toContain(code)
    },
  )

  it.each(['invalid-input-response', 'timeout-or-duplicate'])(
    'siteverify responde %s: sigue siendo 403 CAPTCHA_FAILED, culpa del token',
    async (code) => {
      const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
      replying({ success: false, 'error-codes': [code] })

      const res = await submitAdvanceRequest(app, { token: TOKEN })

      expect(res.status, JSON.stringify(res.body)).toBe(403)
      expect(apiErrorEnvelopeSchema.parse(res.body).code).toBe('CAPTCHA_FAILED')
      expect(error).not.toHaveBeenCalled()
    },
  )

  it('siteverify no responde: 503 CAPTCHA_UNAVAILABLE con log de error, nunca deja pasar', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    siteverify.mockRejectedValueOnce(new DOMException('The operation was aborted', 'TimeoutError'))

    const res = await submitAdvanceRequest(app, { token: TOKEN })

    expect(res.status, JSON.stringify(res.body)).toBe(503)
    expect(apiErrorEnvelopeSchema.parse(res.body).code).toBe('CAPTCHA_UNAVAILABLE')
    expect(error).toHaveBeenCalled()
  })
})
