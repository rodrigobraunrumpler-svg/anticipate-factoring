import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  API_ERROR_HTTP_STATUS,
  API_ERROR_MESSAGES_ES,
  type ApiErrorCode,
  apiErrorEnvelopeSchema,
  tooManyFilesMessage,
} from '@anticipate/shared/api'
import {
  Body,
  type CanActivate,
  Controller,
  HttpCode,
  Injectable,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import multer from 'multer'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { APP_CONFIG } from '#/common/config/index.js'
import { AllExceptionsFilter } from '#/common/filters/index.js'
import { testConfig } from '../../../test/support/config.js'
import { INFLIGHT_BODY_BUDGET, InflightBodyBudget } from './inflight-body-budget.js'
import {
  INFLIGHT_BODY_RETRY_AFTER_SECONDS,
  MultipartFilesInterceptor,
  type MultipartLimits,
  multipartErrorToApiError,
} from './multipart-files.interceptor.js'

describe('multipartErrorToApiError', () => {
  it.each([
    ['LIMIT_FILE_COUNT', 'TOO_MANY_FILES'],
    ['LIMIT_PART_COUNT', 'TOO_MANY_FILES'],
    ['LIMIT_UNEXPECTED_FILE', 'UNEXPECTED_FILE_FIELD'],
    ['LIMIT_FILE_SIZE', 'PAYLOAD_TOO_LARGE'],
    ['LIMIT_FIELD_KEY', 'MALFORMED_MULTIPART'],
    ['LIMIT_FIELD_VALUE', 'MALFORMED_MULTIPART'],
    ['LIMIT_FIELD_COUNT', 'MALFORMED_MULTIPART'],
    ['MISSING_FIELD_NAME', 'MALFORMED_MULTIPART'],
    ['LIMIT_FIELD_NESTING', 'MALFORMED_MULTIPART'],
    ['LIMIT_FIELD_ARRAY_INDEX', 'MALFORMED_MULTIPART'],
    ['STREAM_DESTROYED', 'MALFORMED_MULTIPART'],
    ['INVALID_FIELD_NAME', 'MALFORMED_MULTIPART'],
    ['UN_CODIGO_NUEVO', 'MALFORMED_MULTIPART'],
  ] as const)('MulterError %s → %s', (multerCode, apiCode) => {
    const error = multipartErrorToApiError(
      new multer.MulterError(multerCode as multer.ErrorCode, 'campo-del-cliente'),
      { files: 7 },
    )
    expect(error.publicCode).toBe(apiCode)
    expect(error.message).toBe(`multer: ${multerCode}`)
    expect(error.message).not.toContain('campo-del-cliente')
    // Solo TOO_MANY_FILES dice su tope: con él, el proveedor sabe cuántos archivos quitar.
    expect(error.publicMessage).toBe(
      apiCode === 'TOO_MANY_FILES' ? tooManyFilesMessage(7) : API_ERROR_MESSAGES_ES[apiCode],
    )
  })

  it.each([
    ['un error de busboy', new Error('Unexpected end of form')],
    ['un corte del cliente', new Error('Request aborted')],
    ['algo que no es Error', 'texto'],
  ])('%s → MALFORMED_MULTIPART', (_label, error) => {
    expect(multipartErrorToApiError(error, { files: 7 }).publicCode).toBe('MALFORMED_MULTIPART')
  })
})

describe('MultipartFilesInterceptor: configuración', () => {
  const limits: MultipartLimits = { files: 3, fileSize: 64, parts: 4, fields: 2, fieldSize: 128 }

  it('rechaza campos vacíos, repetidos o sin tope', () => {
    expect(() => MultipartFilesInterceptor([], () => limits)).toThrow(TypeError)
    expect(() =>
      MultipartFilesInterceptor(
        [
          { name: 'xml', maxCount: 1 },
          { name: 'xml', maxCount: 1 },
        ],
        () => limits,
      ),
    ).toThrow(TypeError)
    expect(() => MultipartFilesInterceptor([{ name: 'xml', maxCount: 0 }], () => limits)).toThrow(
      TypeError,
    )
  })

  it('rechaza topes que no son enteros positivos al crear el interceptor', () => {
    const Interceptor = MultipartFilesInterceptor([{ name: 'xml', maxCount: 1 }], () => ({
      ...limits,
      fileSize: Number.POSITIVE_INFINITY,
    }))
    expect(() => new Interceptor(testConfig(), new InflightBodyBudget(1_000))).toThrow(TypeError)
  })
})

const LIMITS: MultipartLimits = { files: 3, fileSize: 64, parts: 4, fields: 2, fieldSize: 128 }

/** Presupuesto de las pruebas del presupuesto: cabe un envío de `HELD_BYTES` y no dos. */
const BUDGET_BYTES = 1_500
const HELD_BYTES = 1_000
const BUDGET_LIMITS: MultipartLimits = {
  files: 3,
  fileSize: 64,
  parts: 4,
  fields: 2,
  fieldSize: 4_096,
}

let handled = 0
let releaseHandler: () => void = () => undefined
let handlerGate: Promise<void> = Promise.resolve()
let guardGate: Promise<void> = Promise.resolve()
let guardEntered = 0

/** Un guard lento, como el del captcha que espera a Cloudflare antes de leer el cuerpo. */
@Injectable()
class SlowGuard implements CanActivate {
  async canActivate(): Promise<boolean> {
    guardEntered += 1
    await guardGate
    return true
  }
}

@Controller('upload')
class UploadController {
  @Post()
  @HttpCode(200)
  @UseInterceptors(
    MultipartFilesInterceptor(
      [
        { name: 'xml', maxCount: 3 },
        { name: 'pdf', maxCount: 3 },
      ],
      () => LIMITS,
    ),
  )
  upload(
    @UploadedFiles() files: Record<string, Express.Multer.File[]>,
    @Body() body: Record<string, string>,
  ) {
    return {
      form: body.form ?? null,
      files: Object.values(files)
        .flat()
        .map((file) => ({ field: file.fieldname, name: file.originalname, size: file.size })),
    }
  }
}

describe('MultipartFilesInterceptor con multer real', () => {
  let app: NestExpressApplication
  const budget = new InflightBodyBudget(1_000_000)

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [UploadController],
      providers: [
        { provide: APP_CONFIG, useValue: testConfig() },
        { provide: INFLIGHT_BODY_BUDGET, useValue: budget },
      ],
    }).compile()
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false })
    app.useGlobalFilters(new AllExceptionsFilter())
    await app.init()
  })

  afterEach(() => {
    // Cada envío devuelve su reserva, también los que terminan en error.
    expect(budget.reservedBytes).toBe(0)
  })

  afterAll(async () => {
    await app.close()
  })

  const upload = () => request(app.getHttpServer()).post('/upload')

  function expectError(
    response: { status: number; body: unknown },
    code: ApiErrorCode,
    message: string = API_ERROR_MESSAGES_ES[code],
  ) {
    expect(apiErrorEnvelopeSchema.safeParse(response.body).error?.issues ?? []).toEqual([])
    expect(response.status).toBe(API_ERROR_HTTP_STATUS[code])
    expect(response.body).toMatchObject({ code, message })
  }

  it('lee los archivos y el campo de texto, con nombres en UTF-8', async () => {
    const response = await upload()
      .field('form', '{"a":1}')
      .attach('xml', Buffer.from('<Invoice/>'), 'Factura-ñandú-001.xml')
      .attach('pdf', Buffer.from('%PDF-1.7'), 'Factura-ñandú-001.pdf')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      form: '{"a":1}',
      files: [
        { field: 'xml', name: 'Factura-ñandú-001.xml', size: 10 },
        { field: 'pdf', name: 'Factura-ñandú-001.pdf', size: 8 },
      ],
    })
  })

  it('más archivos que el tope: 400 TOO_MANY_FILES con el tope en el mensaje', async () => {
    let req = upload()
    for (let n = 0; n < 4; n += 1) req = req.attach('xml', Buffer.from('<a/>'), `f${n}.xml`)
    expectError(await req, 'TOO_MANY_FILES', tooManyFilesMessage(LIMITS.files))
  })

  it('más partes que el tope: 400 TOO_MANY_FILES con el tope de archivos en el mensaje', async () => {
    const response = await upload()
      .field('form', '{}')
      .field('otro', 'x')
      .attach('xml', Buffer.from('<a/>'), 'a.xml')
      .attach('xml', Buffer.from('<a/>'), 'b.xml')
      .attach('pdf', Buffer.from('%PDF'), 'a.pdf')
    expectError(response, 'TOO_MANY_FILES', tooManyFilesMessage(LIMITS.files))
  })

  it('un campo de archivos no permitido: 400 UNEXPECTED_FILE_FIELD', async () => {
    expectError(await upload().attach('doc', Buffer.from('x'), 'x.txt'), 'UNEXPECTED_FILE_FIELD')
  })

  it('un archivo mayor que el tope: 413 PAYLOAD_TOO_LARGE', async () => {
    expectError(
      await upload().attach('xml', Buffer.alloc(100, 'a'), 'grande.xml'),
      'PAYLOAD_TOO_LARGE',
    )
  })

  it('un campo de texto demasiado largo o demasiados campos: 400 MALFORMED_MULTIPART', async () => {
    expectError(await upload().field('form', 'x'.repeat(200)), 'MALFORMED_MULTIPART')
    expectError(
      await upload().field('a', '1').field('b', '2').field('c', '3'),
      'MALFORMED_MULTIPART',
    )
  })

  it('un multipart cortado o sin boundary: 400 MALFORMED_MULTIPART', async () => {
    expectError(
      await upload()
        .set('content-type', 'multipart/form-data; boundary=limite')
        .send('--limite\r\nContent-Disposition: form-data; name="form"\r\n\r\nsin cierre'),
      'MALFORMED_MULTIPART',
    )
    expectError(
      await upload().set('content-type', 'multipart/form-data').send('x'),
      'MALFORMED_MULTIPART',
    )
  })

  it('una solicitud que no es multipart: 400 MALFORMED_MULTIPART', async () => {
    expectError(await upload().send({ form: {} }), 'MALFORMED_MULTIPART')
  })
})

@Controller('budget-upload')
class BudgetUploadController {
  @Post()
  @HttpCode(200)
  @UseInterceptors(MultipartFilesInterceptor([{ name: 'xml', maxCount: 3 }], () => BUDGET_LIMITS))
  async upload(@Body() body: Record<string, string>) {
    handled += 1
    if (body.form === 'fallar') throw new Error('el caso de uso falló')
    if (body.form === 'esperar') await handlerGate
    return { form: body.form ?? null }
  }

  @Post('lento')
  @HttpCode(200)
  @UseGuards(SlowGuard)
  @UseInterceptors(MultipartFilesInterceptor([{ name: 'xml', maxCount: 3 }], () => BUDGET_LIMITS))
  slow(@Body() body: Record<string, string>) {
    handled += 1
    return { form: body.form ?? null }
  }
}

describe('MultipartFilesInterceptor: presupuesto de cuerpos en memoria', () => {
  let app: NestExpressApplication
  const budget = new InflightBodyBudget(BUDGET_BYTES)

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [BudgetUploadController],
      providers: [
        { provide: APP_CONFIG, useValue: testConfig() },
        { provide: INFLIGHT_BODY_BUDGET, useValue: budget },
      ],
    }).compile()
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false })
    app.useGlobalFilters(new AllExceptionsFilter())
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  afterEach(() => {
    expect(budget.reservedBytes).toBe(0)
  })

  /** Una petición multipart a mano: `declared` en `Content-Length` (o chunked) y `body` como cuerpo. */
  async function openUpload(options: {
    declared: number | null
    body: string
    end: boolean
    path?: string
  }) {
    const server = app.getHttpServer()
    if (!server.listening)
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    let resolveResponse: (value: { status: number; retryAfter?: string; body: string }) => void =
      () => undefined
    const response = new Promise<{ status: number; retryAfter?: string; body: string }>(
      (resolve) => {
        resolveResponse = resolve
      },
    )
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: options.path ?? '/budget-upload',
        headers: {
          'content-type': 'multipart/form-data; boundary=limite',
          ...(options.declared === null
            ? { 'transfer-encoding': 'chunked' }
            : { 'content-length': String(options.declared) }),
        },
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          text += chunk
        })
        res.on('end', () =>
          resolveResponse({
            status: res.statusCode ?? 0,
            ...(typeof res.headers['retry-after'] === 'string'
              ? { retryAfter: res.headers['retry-after'] }
              : {}),
            body: text,
          }),
        )
      },
    )
    req.on('error', () => resolveResponse({ status: 0, body: '' }))
    req.write(options.body)
    if (options.end) req.end()
    return { req, response }
  }

  /** Un multipart completo de exactamente `size` bytes: el campo `form` y un campo de relleno. */
  function multipartOf(form: string, size: number): string {
    const head = `--limite\r\nContent-Disposition: form-data; name="form"\r\n\r\n${form}\r\n`
    const padding = `--limite\r\nContent-Disposition: form-data; name="relleno"\r\n\r\n`
    const tail = '\r\n--limite--\r\n'
    const fill = size - head.length - padding.length - tail.length
    // El relleno es un campo de texto: tiene que caber en `fieldSize`.
    expect(fill).toBeGreaterThan(0)
    expect(fill).toBeLessThanOrEqual(BUDGET_LIMITS.fieldSize)
    return `${head}${padding}${'x'.repeat(fill)}${tail}`
  }

  const waitFor = async (condition: () => boolean) => {
    for (let n = 0; n < 200 && !condition(); n += 1) await new Promise((r) => setTimeout(r, 5))
    expect(condition()).toBe(true)
  }

  it('sin Content-Length válido no reserva ni lee: 411 LENGTH_REQUIRED', async () => {
    const chunked = await openUpload({ declared: null, body: '--limite--\r\n', end: true })
    const res = await chunked.response
    expect(res.status).toBe(411)
    expect(JSON.parse(res.body)).toMatchObject({ code: 'LENGTH_REQUIRED' })
  })

  it('con el presupuesto ocupado, 503 SERVICE_UNAVAILABLE con Retry-After y sin leer el cuerpo; al terminar el primero, entra el siguiente', async () => {
    handlerGate = new Promise((resolve) => {
      releaseHandler = resolve
    })
    const before = handled
    // El primero se lee entero y queda en el caso de uso, con sus bytes en memoria.
    const first = await openUpload({
      declared: HELD_BYTES,
      body: multipartOf('esperar', HELD_BYTES),
      end: true,
    })
    await waitFor(() => handled === before + 1)
    expect(budget.reservedBytes).toBe(HELD_BYTES)
    const second = await openUpload({
      declared: HELD_BYTES,
      body: multipartOf('{}', HELD_BYTES),
      end: true,
    })
    const rejected = await second.response
    expect(rejected.status).toBe(503)
    expect(rejected.retryAfter).toBe(String(INFLIGHT_BODY_RETRY_AFTER_SECONDS))
    expect(JSON.parse(rejected.body)).toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(handled).toBe(before + 1)
    // Uno chico todavía cabe.
    const small = await request(app.getHttpServer()).post('/budget-upload').field('form', '{}')
    expect(small.status).toBe(200)
    releaseHandler()
    expect((await first.response).status).toBe(200)
    await waitFor(() => budget.reservedBytes === 0)
    const third = await openUpload({
      declared: HELD_BYTES,
      body: multipartOf('{}', HELD_BYTES),
      end: true,
    })
    expect((await third.response).status).toBe(200)
  })

  it('libera la reserva si el caso de uso falla o multer rechaza el cuerpo', async () => {
    const failed = await openUpload({
      declared: HELD_BYTES,
      body: multipartOf('fallar', HELD_BYTES),
      end: true,
    })
    expect((await failed.response).status).toBe(500)
    await waitFor(() => budget.reservedBytes === 0)
    const tooLarge = await request(app.getHttpServer())
      .post('/budget-upload')
      .attach('xml', Buffer.alloc(100, 'a'), 'grande.xml')
    expect(tooLarge.status).toBe(413)
    expect(budget.reservedBytes).toBe(0)
  })

  it('libera la reserva si el cliente corta a mitad del cuerpo', async () => {
    const cut = await openUpload({
      declared: HELD_BYTES,
      body: multipartOf('{}', HELD_BYTES).slice(0, 100),
      end: false,
    })
    await waitFor(() => budget.reservedBytes === HELD_BYTES)
    cut.req.destroy()
    await waitFor(() => budget.reservedBytes === 0)
  })

  it('si el cliente corta mientras corren los guards, no reserva nada ni deja la lectura colgada', async () => {
    let openGate: () => void = () => undefined
    guardGate = new Promise((resolve) => {
      openGate = resolve
    })
    const entered = guardEntered
    const before = handled
    const cut = await openUpload({
      path: '/budget-upload/lento',
      declared: HELD_BYTES,
      body: multipartOf('{}', HELD_BYTES).slice(0, 100),
      end: false,
    })
    await waitFor(() => guardEntered === entered + 1)
    // El cliente se va mientras el guard espera: los 'close' pasan antes de que corra el interceptor.
    cut.req.destroy()
    await new Promise((resolve) => setTimeout(resolve, 50))
    openGate()
    guardGate = Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(budget.reservedBytes).toBe(0)
    expect(handled).toBe(before)
  })
})
