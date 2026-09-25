import { DEFAULT_SUCCESS_MESSAGE } from '@anticipate/shared/api'
import { VersioningType } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { API_DEFAULT_VERSION, API_PREFIX } from '#/bootstrap/constants.js'
import { CORRELATION_ID_HEADER } from '#/common/constants/http-headers.constants.js'
import { PAYER_REPOSITORY, type PayerRepositoryPort } from '#/modules/payers/index.js'
import { PayersModule } from '#/modules/payers/payers.module.js'
import { PUBLIC_PAYERS_CACHE_CONTROL } from '../constants/public-payers.constants.js'

type SchemaNode = { properties?: Record<string, SchemaNode>; items?: SchemaNode }
type ResponseDoc = {
  description?: string
  headers?: Record<string, { schema?: { example?: unknown } }>
  content?: Record<string, { schema?: SchemaNode }>
}

describe('documentación de GET /api/v1/payers', () => {
  let app: NestExpressApplication
  let tags: string[] | undefined
  let responses: Record<string, ResponseDoc> | undefined

  beforeAll(async () => {
    const repository: PayerRepositoryPort = { listActive: async () => [] }
    const moduleRef = await Test.createTestingModule({ imports: [PayersModule] })
      .overrideProvider(PAYER_REPOSITORY)
      .useValue(repository)
      .compile()
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false })
    app.setGlobalPrefix(API_PREFIX)
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: API_DEFAULT_VERSION })
    await app.init()
    const operation = SwaggerModule.createDocument(app, new DocumentBuilder().build()).paths[
      '/api/v1/payers'
    ]?.get
    tags = operation?.tags
    responses = operation?.responses as Record<string, ResponseDoc> | undefined
  })

  afterAll(async () => {
    await app.close()
  })

  it('describe el éxito con el sobre, el contrato público del pagador y sus cabeceras', () => {
    const ok = responses?.['200']
    const envelope = ok?.content?.['application/json']?.schema
    expect(tags).toEqual(['payers'])
    expect(ok?.description).toContain(DEFAULT_SUCCESS_MESSAGE)
    expect(Object.keys(envelope?.properties ?? {})).toEqual(
      expect.arrayContaining([
        'success',
        'statusCode',
        'message',
        'data',
        'correlationId',
        'timestamp',
      ]),
    )
    expect(Object.keys(envelope?.properties?.data?.items?.properties ?? {}).sort()).toEqual([
      'accentColor',
      'advancePercent',
      'allowedCurrencies',
      'legalName',
      'logoUrl',
      'maxInvoices',
      'minTermDays',
      'ruc',
      'shortName',
      'slug',
      'texts',
    ])
    expect(Object.keys(ok?.headers ?? {})).toEqual(
      expect.arrayContaining([CORRELATION_ID_HEADER, 'Cache-Control']),
    )
    expect(ok?.headers?.['Cache-Control']?.schema?.example).toBe(PUBLIC_PAYERS_CACHE_CONTROL)
  })

  it('documenta solo los errores comunes a toda ruta', () => {
    expect(Object.keys(responses ?? {}).sort()).toEqual(['200', '429', '500', '503'])
  })
})
