import {
  apiSuccessEnvelopeSchema,
  DEFAULT_SUCCESS_MESSAGE,
  intakeLimitsSchema,
} from '@anticipate/shared/api'
import type { NestExpressApplication } from '@nestjs/platform-express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CORRELATION_ID_HEADER } from '#/common/constants/http-headers.constants.js'
import { createTestApp } from '../support/app.js'

const INTAKE_LIMITS_PATH = '/api/v1/intake-limits'
const envelopeSchema = apiSuccessEnvelopeSchema(intakeLimitsSchema)

describe('GET /api/v1/intake-limits en la app completa', () => {
  let app: NestExpressApplication

  beforeAll(async () => {
    app = await createTestApp({
      env: { UPLOAD_MAX_FILES: '24', UPLOAD_MAX_PDF_BYTES: '5242880' },
    })
  })

  afterAll(async () => {
    await app.close()
  })

  it('responde los topes de la configuración en el sobre, con caché pública y la correlación', async () => {
    const res = await request(app.getHttpServer())
      .get(INTAKE_LIMITS_PATH)
      .set(CORRELATION_ID_HEADER, 'landing-build-7')
      .expect(200)

    const body = envelopeSchema.parse(res.body)
    expect(body).toMatchObject({
      success: true,
      statusCode: 200,
      message: DEFAULT_SUCCESS_MESSAGE,
      correlationId: 'landing-build-7',
      data: {
        maxFiles: 24,
        maxXmlBytes: 1_048_576,
        maxPdfBytes: 5_242_880,
        maxBodyBytes: 95_000_000,
      },
    })
    expect(res.headers[CORRELATION_ID_HEADER]).toBe('landing-build-7')
    expect(res.headers['cache-control']).toBe('public, max-age=300')
  })

  it('no le aplica el tope por Content-Length del envío: un GET sin cuerpo no es 411', async () => {
    const res = await request(app.getHttpServer()).get(INTAKE_LIMITS_PATH).unset('Content-Length')
    expect(res.status).toBe(200)
  })
})
