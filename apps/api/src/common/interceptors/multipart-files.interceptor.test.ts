import {
  API_ERROR_HTTP_STATUS,
  API_ERROR_MESSAGES_ES,
  type ApiErrorCode,
  apiErrorEnvelopeSchema,
} from '@anticipate/shared/api'
import { Body, Controller, HttpCode, Post, UploadedFiles, UseInterceptors } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import multer from 'multer'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { APP_CONFIG } from '#/common/config/index.js'
import { AllExceptionsFilter } from '#/common/filters/index.js'
import { testConfig } from '../../../test/support/config.js'
import {
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
    )
    expect(error.publicCode).toBe(apiCode)
    expect(error.message).toBe(`multer: ${multerCode}`)
    expect(error.message).not.toContain('campo-del-cliente')
  })

  it.each([
    ['un error de busboy', new Error('Unexpected end of form')],
    ['un corte del cliente', new Error('Request aborted')],
    ['algo que no es Error', 'texto'],
  ])('%s → MALFORMED_MULTIPART', (_label, error) => {
    expect(multipartErrorToApiError(error).publicCode).toBe('MALFORMED_MULTIPART')
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
    expect(() => new Interceptor(testConfig())).toThrow(TypeError)
  })
})

const LIMITS: MultipartLimits = { files: 3, fileSize: 64, parts: 4, fields: 2, fieldSize: 128 }

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

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [UploadController],
      providers: [{ provide: APP_CONFIG, useValue: testConfig() }],
    }).compile()
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false })
    app.useGlobalFilters(new AllExceptionsFilter())
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  const upload = () => request(app.getHttpServer()).post('/upload')

  function expectError(response: { status: number; body: unknown }, code: ApiErrorCode) {
    expect(apiErrorEnvelopeSchema.safeParse(response.body).error?.issues ?? []).toEqual([])
    expect(response.status).toBe(API_ERROR_HTTP_STATUS[code])
    expect(response.body).toMatchObject({ code, message: API_ERROR_MESSAGES_ES[code] })
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

  it('más archivos que el tope: 400 TOO_MANY_FILES', async () => {
    let req = upload()
    for (let n = 0; n < 4; n += 1) req = req.attach('xml', Buffer.from('<a/>'), `f${n}.xml`)
    expectError(await req, 'TOO_MANY_FILES')
  })

  it('más partes que el tope: 400 TOO_MANY_FILES', async () => {
    const response = await upload()
      .field('form', '{}')
      .field('otro', 'x')
      .attach('xml', Buffer.from('<a/>'), 'a.xml')
      .attach('xml', Buffer.from('<a/>'), 'b.xml')
      .attach('pdf', Buffer.from('%PDF'), 'a.pdf')
    expectError(response, 'TOO_MANY_FILES')
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
