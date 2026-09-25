import {
  API_ERROR_HTTP_STATUS,
  API_ERROR_MESSAGES_ES,
  type ApiErrorCode,
  apiErrorEnvelopeSchema,
} from '@anticipate/shared/api'
import { Body, Controller, HttpCode, Post } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import type { NextFunction, Request, Response } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AllExceptionsFilter } from '#/common/filters/index.js'
import { bodyParserErrorMiddleware } from './body-parser-error.middleware.js'

@Controller('echo')
class EchoController {
  @Post()
  @HttpCode(200)
  echo(@Body() body: unknown) {
    return body
  }
}

describe('bodyParserErrorMiddleware con body-parser real', () => {
  let app: NestExpressApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [EchoController] }).compile()
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      logger: false,
    })
    app.useBodyParser('json', { limit: 64 })
    app.use(bodyParserErrorMiddleware)
    app.useGlobalFilters(new AllExceptionsFilter())
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  function expectError(
    response: { status: number; body: unknown; headers: Record<string, string> },
    code: ApiErrorCode,
  ) {
    expect(apiErrorEnvelopeSchema.safeParse(response.body).error?.issues ?? []).toEqual([])
    expect(response.status).toBe(API_ERROR_HTTP_STATUS[code])
    expect(response.body).toMatchObject({ code, message: API_ERROR_MESSAGES_ES[code] })
    expect(response.headers['x-correlation-id']).toBe(
      (response.body as { correlationId: string }).correlationId,
    )
  }

  it('un JSON ilegible es 400 MALFORMED_JSON, sin el mensaje del parser', async () => {
    const response = await request(app.getHttpServer())
      .post('/echo')
      .set('content-type', 'application/json')
      .send('{"a":')
    expectError(response, 'MALFORMED_JSON')
    expect(JSON.stringify(response.body)).not.toMatch(/JSON at position|Unexpected|Expected/i)
  })

  it('un JSON mayor que el límite es 413 PAYLOAD_TOO_LARGE', async () => {
    const response = await request(app.getHttpServer())
      .post('/echo')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ text: 'x'.repeat(200) }))
    expectError(response, 'PAYLOAD_TOO_LARGE')
  })

  it('un charset que body-parser no acepta es 400 BAD_REQUEST', async () => {
    const response = await request(app.getHttpServer())
      .post('/echo')
      .set('content-type', 'application/json; charset=latin1')
      .send('{}')
    expectError(response, 'BAD_REQUEST')
  })

  it('un JSON válido pasa sin cambios', async () => {
    const response = await request(app.getHttpServer()).post('/echo').send({ ok: true })
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true })
  })
})

describe('bodyParserErrorMiddleware', () => {
  const run = (error: unknown): unknown => {
    let forwarded: unknown
    const next = ((value?: unknown) => {
      forwarded = value
    }) as NextFunction
    bodyParserErrorMiddleware(error, {} as Request, {} as Response, next)
    return forwarded
  }

  it('reemplaza el SyntaxError del parser por un error plano con solo status y type', () => {
    const parserError = Object.assign(new SyntaxError('Unexpected token } in JSON "secreto"'), {
      status: 400,
      statusCode: 400,
      type: 'entity.parse.failed',
      body: '{"secreto": }',
    })
    const replaced = run(parserError)
    expect(replaced).toBeInstanceOf(Error)
    expect(replaced).not.toBeInstanceOf(SyntaxError)
    expect(replaced).toMatchObject({ status: 400, statusCode: 400, type: 'entity.parse.failed' })
    expect(replaced).not.toHaveProperty('body')
    expect(String((replaced as Error).message)).not.toContain('secreto')
  })

  it('deja pasar cualquier otro error tal cual', () => {
    const other = new Error('otro')
    expect(run(other)).toBe(other)
    const withStatusOnly = Object.assign(new Error('x'), { status: 400 })
    expect(run(withStatusOnly)).toBe(withStatusOnly)
  })
})
