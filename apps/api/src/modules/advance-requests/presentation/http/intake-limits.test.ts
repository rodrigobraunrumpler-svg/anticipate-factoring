import { DEFAULT_SUCCESS_MESSAGE, intakeLimitsSchema } from '@anticipate/shared/api'
import { VersioningType } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { API_DEFAULT_VERSION, API_PREFIX } from '#/bootstrap/constants.js'
import { APP_CONFIG } from '#/common/config/index.js'
import { CORRELATION_ID_HEADER } from '#/common/constants/http-headers.constants.js'
import { testConfig } from '../../../../../test/support/config.js'
import { INTAKE_LIMITS_CACHE_CONTROL } from './constants/intake-limits.constants.js'
import { IntakeLimitsController } from './controllers/intake-limits.controller.js'
import { toIntakeLimits } from './mappers/intake-limits.mapper.js'

type SchemaNode = { properties?: Record<string, SchemaNode> }
type ResponseDoc = {
  description?: string
  headers?: Record<string, { schema?: { example?: unknown } }>
  content?: Record<string, { schema?: SchemaNode }>
}

describe('toIntakeLimits', () => {
  it('publica solo los cuatro topes que la landing revisa, nunca el presupuesto de memoria', () => {
    const limits = toIntakeLimits(testConfig().upload)
    expect(limits).toEqual({
      maxFiles: 20,
      maxXmlBytes: 1_048_576,
      maxPdfBytes: 10_485_760,
      maxBodyBytes: 95_000_000,
    })
    expect(intakeLimitsSchema.parse(limits)).toEqual(limits)
  })

  it('sigue a la configuración', () => {
    const config = testConfig({
      UPLOAD_MAX_FILES: '30',
      UPLOAD_MAX_XML_BYTES: '2000000',
      UPLOAD_MAX_PDF_BYTES: '5000000',
      UPLOAD_MAX_BODY_BYTES: '80000000',
    })
    expect(toIntakeLimits(config.upload)).toEqual({
      maxFiles: 30,
      maxXmlBytes: 2_000_000,
      maxPdfBytes: 5_000_000,
      maxBodyBytes: 80_000_000,
    })
  })
})

describe('GET /api/v1/intake-limits', () => {
  let app: NestExpressApplication
  let responses: Record<string, ResponseDoc> | undefined
  let tags: string[] | undefined

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [IntakeLimitsController],
      providers: [{ provide: APP_CONFIG, useValue: testConfig({ UPLOAD_MAX_FILES: '24' }) }],
    }).compile()
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false })
    app.setGlobalPrefix(API_PREFIX)
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: API_DEFAULT_VERSION })
    await app.init()
    const operation = SwaggerModule.createDocument(app, new DocumentBuilder().build()).paths[
      '/api/v1/intake-limits'
    ]?.get
    tags = operation?.tags
    responses = operation?.responses as Record<string, ResponseDoc> | undefined
  })

  afterAll(async () => {
    await app.close()
  })

  it('responde los topes de la configuración con la caché pública de los catálogos', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/intake-limits')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      maxFiles: 24,
      maxXmlBytes: 1_048_576,
      maxPdfBytes: 10_485_760,
      maxBodyBytes: 95_000_000,
    })
    expect(response.headers['cache-control']).toBe(INTAKE_LIMITS_CACHE_CONTROL)
    expect(INTAKE_LIMITS_CACHE_CONTROL).toBe('public, max-age=300')
  })

  it('documenta el sobre con el contrato de shared, la caché y los errores comunes', () => {
    const ok = responses?.['200']
    const envelope = ok?.content?.['application/json']?.schema
    expect(tags).toEqual(['Solicitudes de adelanto'])
    expect(ok?.description).toContain(DEFAULT_SUCCESS_MESSAGE)
    expect(Object.keys(envelope?.properties?.data?.properties ?? {}).sort()).toEqual([
      'maxBodyBytes',
      'maxFiles',
      'maxPdfBytes',
      'maxXmlBytes',
    ])
    expect(Object.keys(ok?.headers ?? {})).toEqual(
      expect.arrayContaining([CORRELATION_ID_HEADER, 'Cache-Control']),
    )
    expect(ok?.headers?.['Cache-Control']?.schema?.example).toBe(INTAKE_LIMITS_CACHE_CONTROL)
    expect(Object.keys(responses ?? {}).sort()).toEqual(['200', '429', '500', '503'])
  })
})
