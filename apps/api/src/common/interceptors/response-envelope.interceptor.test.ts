import {
  apiSuccessEnvelopeSchema,
  DEFAULT_SUCCESS_MESSAGE,
  SUCCESS_MESSAGES_ES,
} from '@anticipate/shared/api'
import {
  Controller,
  type ExecutionContext,
  Get,
  HttpCode,
  Post,
  StreamableFile,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { firstValueFrom, of } from 'rxjs'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ResponseMessage } from '#/common/decorators/response-message.decorator.js'
import { SkipResponseEnvelope } from '#/common/decorators/skip-response-envelope.decorator.js'
import { CursorPaginatedList, PaginatedList } from '#/common/types/paginated-list.js'
import { ResponseEnvelopeInterceptor } from './response-envelope.interceptor.js'

const item = z.strictObject({ id: z.string() })

@Controller('envelope')
@ResponseMessage('Mensaje del controlador.')
class EnvelopeController {
  @Get('plain')
  plain() {
    return { id: 'a' }
  }

  @Post('created')
  @HttpCode(201)
  @ResponseMessage(SUCCESS_MESSAGES_ES.advanceRequestCreated)
  created() {
    return { id: 'b' }
  }

  @Get('empty')
  empty(): void {}

  @Get('page')
  page() {
    return PaginatedList.of([{ id: 'a' }, { id: 'b' }], {
      totalCount: 3,
      currentPage: 1,
      perPage: 2,
    })
  }

  @Get('cursor')
  cursor() {
    return CursorPaginatedList.fromLookahead(
      [{ id: 'c' }, { id: 'b' }, { id: 'a' }],
      2,
      (row) => row.id,
    )
  }

  @Get('raw')
  @SkipResponseEnvelope()
  raw() {
    return { status: 'ok' }
  }

  @Get('file')
  file() {
    return new StreamableFile(Buffer.from('hola'), { type: 'text/plain' })
  }
}

@Controller('raw-controller')
@SkipResponseEnvelope()
class RawController {
  @Get()
  raw() {
    return { status: 'ok' }
  }
}

@Controller('default-message')
class DefaultMessageController {
  @Get()
  get() {
    return [1, 2]
  }
}

describe('ResponseEnvelopeInterceptor', () => {
  let app: NestExpressApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [EnvelopeController, RawController, DefaultMessageController],
    }).compile()
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false })
    app.useGlobalInterceptors(new ResponseEnvelopeInterceptor(new Reflector()))
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  const get = (path: string) =>
    request(app.getHttpServer()).get(path).set('x-correlation-id', 'prueba-1')

  it('envuelve el resultado en el sobre, con el mensaje por defecto', async () => {
    const response = await request(app.getHttpServer()).get('/default-message')
    expect(response.status).toBe(200)
    expect(apiSuccessEnvelopeSchema(z.array(z.number())).parse(response.body)).toMatchObject({
      success: true,
      statusCode: 200,
      message: DEFAULT_SUCCESS_MESSAGE,
      data: [1, 2],
    })
  })

  it('usa el correlation id de la solicitud y el mensaje del controlador', async () => {
    const response = await get('/envelope/plain')
    expect(apiSuccessEnvelopeSchema(item).parse(response.body)).toMatchObject({
      message: 'Mensaje del controlador.',
      data: { id: 'a' },
      correlationId: 'prueba-1',
    })
  })

  it('el mensaje de la ruta gana al del controlador y el estado es el de la ruta', async () => {
    const response = await request(app.getHttpServer()).post('/envelope/created')
    expect(response.status).toBe(201)
    expect(apiSuccessEnvelopeSchema(item).parse(response.body)).toMatchObject({
      statusCode: 201,
      message: SUCCESS_MESSAGES_ES.advanceRequestCreated,
    })
  })

  it('un resultado vacío sale como data: null', async () => {
    const response = await get('/envelope/empty')
    expect(apiSuccessEnvelopeSchema(z.null()).parse(response.body).data).toBeNull()
  })

  it('PaginatedList sale como data + metadataPagination', async () => {
    const response = await get('/envelope/page')
    const body = apiSuccessEnvelopeSchema(z.array(item)).parse(response.body)
    expect(body.data).toEqual([{ id: 'a' }, { id: 'b' }])
    expect(body.metadataPagination).toEqual({
      totalCount: 3,
      pageCount: 2,
      currentPage: 1,
      isFirstPage: true,
      isLastPage: false,
      previousPage: null,
      nextPage: 2,
    })
    expect(body).not.toHaveProperty('metadataCursor')
  })

  it('CursorPaginatedList sale como data + metadataCursor', async () => {
    const response = await get('/envelope/cursor')
    const body = apiSuccessEnvelopeSchema(z.array(item)).parse(response.body)
    expect(body.data).toEqual([{ id: 'c' }, { id: 'b' }])
    expect(body.metadataCursor).toEqual({ nextCursor: 'b', hasNext: true })
    expect(body).not.toHaveProperty('metadataPagination')
  })

  it('@SkipResponseEnvelope() en la ruta o en el controlador deja el cuerpo tal cual', async () => {
    expect((await get('/envelope/raw')).body).toEqual({ status: 'ok' })
    expect((await get('/raw-controller')).body).toEqual({ status: 'ok' })
  })

  it('un archivo no se envuelve', async () => {
    const response = await get('/envelope/file')
    expect(response.headers['content-type']).toContain('text/plain')
    expect(response.text).toBe('hola')
  })

  it('fuera de HTTP no toca el resultado', async () => {
    const interceptor = new ResponseEnvelopeInterceptor(new Reflector())
    const context = { getType: () => 'rpc' } as unknown as ExecutionContext
    const result = await firstValueFrom(interceptor.intercept(context, { handle: () => of('x') }))
    expect(result).toBe('x')
  })
})

describe('ResponseMessage', () => {
  it('rechaza un mensaje vacío al decorar', () => {
    expect(() => ResponseMessage('  ')).toThrow(TypeError)
  })
})
