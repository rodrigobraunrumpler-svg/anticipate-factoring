import {
  API_ERROR_HTTP_STATUS,
  API_ERROR_MESSAGES_ES,
  type ApiErrorCode,
  apiErrorEnvelopeSchema,
  apiSuccessEnvelopeSchema,
  DEFAULT_SUCCESS_MESSAGE,
  SUCCESS_MESSAGES_ES,
} from '@anticipate/shared/api'
import { createProblem } from '@anticipate/shared/errors'
import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Module,
  Post,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { SkipThrottle, ThrottlerException } from '@nestjs/throttler'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ResponseMessage } from '#/common/decorators/response-message.decorator.js'
import { SkipResponseEnvelope } from '#/common/decorators/skip-response-envelope.decorator.js'
import {
  apiError,
  BusinessRulesViolatedError,
  ServiceUnavailableError,
} from '#/common/exceptions/index.js'
import { MultipartFilesInterceptor } from '#/common/interceptors/multipart-files.interceptor.js'
import { CursorPaginatedList, PaginatedList } from '#/common/types/paginated-list.js'
import { createTestApp } from '../support/app.js'

const probeBodySchema = z.object({
  name: z.string({ error: 'Escribe un nombre.' }).min(3, { error: 'El nombre es muy corto.' }),
  age: z.number(),
})

const item = z.strictObject({ id: z.string() })

@SkipThrottle()
@Controller({ path: 'probe', version: '1' })
class ProbeController {
  @Get('item')
  item() {
    return { id: 'a' }
  }

  @Post('items')
  @HttpCode(201)
  @ResponseMessage(SUCCESS_MESSAGES_ES.advanceRequestCreated)
  create() {
    return { id: 'b' }
  }

  @Get('page')
  page() {
    return PaginatedList.of([{ id: 'a' }], { totalCount: 3, currentPage: 2, perPage: 1 })
  }

  @Get('cursor')
  cursor() {
    return CursorPaginatedList.fromLookahead([{ id: 'b' }, { id: 'a' }], 1, (row) => row.id)
  }

  @Get('raw')
  @SkipResponseEnvelope()
  raw() {
    return { raw: true }
  }

  @Post('validated')
  @HttpCode(200)
  validated(@Body({ schema: probeBodySchema }) body: z.infer<typeof probeBodySchema>) {
    return body
  }

  @Post('echo')
  @HttpCode(200)
  echo(@Body() body: unknown) {
    return body
  }

  @Get('business')
  business() {
    throw new BusinessRulesViolatedError([createProblem('NO_INVOICES')])
  }

  @Get('captcha')
  captcha() {
    throw apiError('CAPTCHA_FAILED')
  }

  @Get('unavailable')
  unavailable() {
    throw new ServiceUnavailableError('dependencia caída en la prueba')
  }

  @Get('conflict')
  conflict() {
    throw new ConflictException('Conflict: english text that must not leak')
  }

  @Get('throttled')
  throttled() {
    throw new ThrottlerException()
  }

  @Get('boom')
  boom() {
    throw new Error('detalle interno secreto')
  }

  @Post('upload')
  @HttpCode(200)
  @UseInterceptors(
    MultipartFilesInterceptor(
      [
        { name: 'xml', maxCount: 2 },
        { name: 'pdf', maxCount: 2 },
      ],
      () => ({ files: 2, fileSize: 64, parts: 3, fields: 1, fieldSize: 256 }),
    ),
  )
  upload(@UploadedFiles() files: Record<string, Express.Multer.File[]>) {
    return Object.values(files)
      .flat()
      .map((file) => file.originalname)
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

/** Frases de Nest, Express, body-parser, multer, throttler y Zod que nunca deben llegar al cliente. */
const ENGLISH =
  /Cannot (GET|POST)|Too Many Requests|Unexpected (token|end|field|file)|Expected property|JSON at position|File too large|Too many (files|parts|fields)|Boundary not found|Internal server error|Bad Request|Not Found|english text|Invalid input|expected (string|number)/i

type HttpResponse = { status: number; body: unknown; headers: Record<string, string>; text: string }

function expectErrorEnvelope(response: HttpResponse, code: ApiErrorCode) {
  expect(apiErrorEnvelopeSchema.safeParse(response.body).error?.issues ?? []).toEqual([])
  expect(response.status).toBe(API_ERROR_HTTP_STATUS[code])
  expect(response.body).toMatchObject({ code, message: API_ERROR_MESSAGES_ES[code] })
  expect(response.headers['x-correlation-id']).toBe(
    (response.body as { correlationId: string }).correlationId,
  )
  expect(response.text).not.toMatch(ENGLISH)
}

describe('contrato HTTP: sobres, errores y correlation id', () => {
  let app: NestExpressApplication

  beforeAll(async () => {
    app = await createTestApp({ extraModules: [ProbeModule] })
  })

  afterAll(async () => {
    await app.close()
  })

  const http = () => request(app.getHttpServer())

  describe('éxitos', () => {
    it('GET devuelve el sobre con el mensaje por defecto y el correlation id de la cabecera', async () => {
      const response = await http().get('/api/v1/probe/item')
      expect(response.status).toBe(200)
      const body = apiSuccessEnvelopeSchema(item).parse(response.body)
      expect(body).toMatchObject({
        statusCode: 200,
        message: DEFAULT_SUCCESS_MESSAGE,
        data: { id: 'a' },
      })
      expect(response.headers['x-correlation-id']).toBe(body.correlationId)
    })

    it('POST con @ResponseMessage() responde 201 con su mensaje', async () => {
      const response = await http().post('/api/v1/probe/items')
      expect(response.status).toBe(201)
      expect(apiSuccessEnvelopeSchema(item).parse(response.body)).toMatchObject({
        statusCode: 201,
        message: SUCCESS_MESSAGES_ES.advanceRequestCreated,
      })
    })

    it('conserva un x-correlation-id válido y reemplaza uno inválido', async () => {
      const kept = await http().get('/api/v1/probe/item').set('x-correlation-id', 'landing.42_a-b')
      expect(kept.headers['x-correlation-id']).toBe('landing.42_a-b')
      expect(kept.body.correlationId).toBe('landing.42_a-b')
      const replaced = await http().get('/api/v1/probe/item').set('x-correlation-id', 'no válido!')
      expect(replaced.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/)
      expect(replaced.body.correlationId).toBe(replaced.headers['x-correlation-id'])
    })

    it('PaginatedList y CursorPaginatedList llevan sus metadatos', async () => {
      const page = apiSuccessEnvelopeSchema(z.array(item)).parse(
        (await http().get('/api/v1/probe/page')).body,
      )
      expect(page.metadataPagination).toMatchObject({ currentPage: 2, pageCount: 3, nextPage: 3 })
      const cursor = apiSuccessEnvelopeSchema(z.array(item)).parse(
        (await http().get('/api/v1/probe/cursor')).body,
      )
      expect(cursor.metadataCursor).toEqual({ nextCursor: 'b', hasNext: true })
    })

    it('@SkipResponseEnvelope() y GET /health responden sin sobre', async () => {
      expect((await http().get('/api/v1/probe/raw')).body).toEqual({ raw: true })
      const health = await http().get('/health')
      expect(health.status).toBe(200)
      expect(health.body).toMatchObject({ status: 'ok' })
      expect(health.body).not.toHaveProperty('success')
      expect(health.headers['x-correlation-id']).toBeTruthy()
    })

    it('el multipart válido llega al controlador con los nombres en UTF-8', async () => {
      const response = await http()
        .post('/api/v1/probe/upload')
        .attach('xml', Buffer.from('<Invoice/>'), 'Año-2026.xml')
      expect(response.status).toBe(200)
      expect(apiSuccessEnvelopeSchema(z.array(z.string())).parse(response.body).data).toEqual([
        'Año-2026.xml',
      ])
    })
  })

  describe('errores', () => {
    it('una ruta inexistente es 404 RESOURCE_NOT_FOUND', async () => {
      expectErrorEnvelope(await http().get('/api/v1/no-existe'), 'RESOURCE_NOT_FOUND')
    })

    it('un JSON ilegible es 400 MALFORMED_JSON y conserva el correlation id recibido', async () => {
      const response = await http()
        .post('/api/v1/probe/echo')
        .set('content-type', 'application/json')
        .set('x-correlation-id', 'json-roto')
        .send('{"name":')
      expectErrorEnvelope(response, 'MALFORMED_JSON')
      expect(response.body.correlationId).toBe('json-roto')
    })

    it('el esquema de @Body() falla con 400 VALIDATION_ERROR agrupado por campo y en español', async () => {
      const response = await http().post('/api/v1/probe/validated').send({ name: 'Al', age: 'x' })
      expectErrorEnvelope(response, 'VALIDATION_ERROR')
      const { violations } = response.body.details as {
        violations: { field: string; messages: string[] }[]
      }
      expect(violations.map((violation) => violation.field)).toEqual(['name', 'age'])
      expect(violations[0]?.messages).toEqual(['El nombre es muy corto.'])
      expect(violations[1]?.messages[0]).not.toMatch(ENGLISH)
    })

    it('las reglas de negocio son 422 con details.problems', async () => {
      const response = await http().get('/api/v1/probe/business')
      expectErrorEnvelope(response, 'BUSINESS_RULES_VIOLATED')
      expect(response.body.details).toEqual({ problems: [createProblem('NO_INVOICES')] })
    })

    it.each([
      ['/api/v1/probe/captcha', 'CAPTCHA_FAILED'],
      ['/api/v1/probe/unavailable', 'SERVICE_UNAVAILABLE'],
      ['/api/v1/probe/conflict', 'CONFLICT'],
      ['/api/v1/probe/throttled', 'RATE_LIMIT_EXCEEDED'],
      ['/api/v1/probe/boom', 'INTERNAL_ERROR'],
    ] as const)('GET %s responde %s con el mensaje en español', async (path, code) => {
      const response = await http().get(path)
      expectErrorEnvelope(response, code)
      expect(response.text).not.toMatch(/secreto|dependencia caída/)
    })

    it.each([
      [
        'más archivos que el tope',
        'TOO_MANY_FILES',
        (req: request.Test) =>
          req
            .attach('xml', Buffer.from('<a/>'), 'a.xml')
            .attach('xml', Buffer.from('<a/>'), 'b.xml')
            .attach('pdf', Buffer.from('%PDF'), 'c.pdf'),
      ],
      [
        'un campo de archivos no permitido',
        'UNEXPECTED_FILE_FIELD',
        (req: request.Test) => req.attach('otro', Buffer.from('x'), 'x.txt'),
      ],
      [
        'un archivo mayor que el tope',
        'PAYLOAD_TOO_LARGE',
        (req: request.Test) => req.attach('xml', Buffer.alloc(100, 'a'), 'grande.xml'),
      ],
      [
        'multipart sin boundary',
        'MALFORMED_MULTIPART',
        (req: request.Test) => req.set('content-type', 'multipart/form-data').send('x'),
      ],
      [
        'cuerpo que no es multipart',
        'MALFORMED_MULTIPART',
        (req: request.Test) => req.send({ xml: 'no' }),
      ],
    ] as const)('upload con %s → %s', async (_label, code, build) => {
      expectErrorEnvelope(await build(http().post('/api/v1/probe/upload')), code)
    })
  })
})
