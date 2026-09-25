import {
  API_ERROR_CODES,
  apiErrorEnvelopeSchema,
  SUCCESS_MESSAGES_ES,
} from '@anticipate/shared/api'
import { Controller, Post } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger'
import { Test } from '@nestjs/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { CORRELATION_ID_HEADER } from '#/common/constants/http-headers.constants.js'
import { ApiEnvelopedResponse } from './api-enveloped-response.swagger.js'
import {
  ApiErrorResponses,
  apiErrorExample,
  COMMON_API_ERROR_CODES,
} from './api-error-responses.swagger.js'

@Controller('docs-probe')
class DocsProbeController {
  @Post()
  @ApiEnvelopedResponse({
    status: 201,
    description: 'Solicitud guardada.',
    data: z.object({ publicCode: z.string() }),
    message: SUCCESS_MESSAGES_ES.advanceRequestCreated,
  })
  @ApiErrorResponses(
    ...COMMON_API_ERROR_CODES,
    'VALIDATION_ERROR',
    'MALFORMED_JSON',
    'CAPTCHA_FAILED',
    'BUSINESS_RULES_VIOLATED',
    'IDEMPOTENCY_KEY_REUSED',
    'RATE_LIMIT_EXCEEDED',
  )
  create() {
    return { publicCode: 'ANT-2026-000001' }
  }
}

type ResponseDoc = {
  description: string
  headers?: Record<string, unknown>
  content: {
    'application/json': {
      schema: {
        properties?: Record<string, { properties?: Record<string, unknown> }>
        oneOf?: unknown[]
      }
      examples?: Record<string, { value: unknown }>
    }
  }
}

describe('decoradores de Swagger', () => {
  let app: NestExpressApplication
  let responses: Record<string, ResponseDoc>

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [DocsProbeController],
    }).compile()
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false })
    await app.init()
    const document: OpenAPIObject = SwaggerModule.createDocument(app, new DocumentBuilder().build())
    responses = document.paths['/docs-probe']?.post?.responses as Record<string, ResponseDoc>
  })

  afterAll(async () => {
    await app.close()
  })

  it('documenta una respuesta por estado, sin repetir', () => {
    expect(Object.keys(responses).sort()).toEqual(['201', '400', '403', '422', '429', '500', '503'])
  })

  it('el éxito usa el sobre de shared con el esquema de data y la cabecera de correlación', () => {
    const created = responses['201']
    expect(created?.description).toContain(SUCCESS_MESSAGES_ES.advanceRequestCreated)
    expect(Object.keys(created?.headers ?? {})).toContain(CORRELATION_ID_HEADER)
    const schema = created?.content['application/json'].schema
    expect(schema?.properties?.data?.properties).toHaveProperty('publicCode')
    expect(schema?.properties).toHaveProperty('correlationId')
  })

  it('cada error trae un ejemplo por código que cumple apiErrorEnvelopeSchema', () => {
    const badRequest = responses['400']
    expect(Object.keys(badRequest?.content['application/json'].examples ?? {})).toEqual([
      'VALIDATION_ERROR',
      'MALFORMED_JSON',
    ])
    expect(responses['422']?.description).toContain('IDEMPOTENCY_KEY_REUSED')
    for (const response of Object.entries(responses).filter(([status]) => status !== '201')) {
      const [, doc] = response
      expect(Object.keys(doc.headers ?? {})).toContain(CORRELATION_ID_HEADER)
      for (const example of Object.values(doc.content['application/json'].examples ?? {})) {
        expect(apiErrorEnvelopeSchema.safeParse(example.value).success).toBe(true)
      }
    }
  })

  it('apiErrorExample cumple el esquema para todo código', () => {
    for (const code of API_ERROR_CODES) {
      expect(apiErrorEnvelopeSchema.safeParse(apiErrorExample(code)).success, code).toBe(true)
    }
  })

  it('ApiErrorResponses() sin códigos es un error de programación', () => {
    expect(() => ApiErrorResponses()).toThrow(TypeError)
  })
})
