import {
  API_ERROR_CODES,
  API_ERROR_HTTP_STATUS,
  API_ERROR_MESSAGES_ES,
  type ApiErrorCode,
  apiErrorEnvelopeSchema,
} from '@anticipate/shared/api'
import { createProblem } from '@anticipate/shared/errors'
import {
  type ArgumentsHost,
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  Logger,
  MethodNotAllowedException,
  NotFoundException,
  NotImplementedException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from '@nestjs/common'
import { ThrottlerException } from '@nestjs/throttler'
import type { Request } from 'express'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import {
  ApiValidationError,
  ApplicationError,
  apiError,
  BusinessRulesViolatedError,
  ServiceUnavailableError,
} from '#/common/exceptions/index.js'
import { AllExceptionsFilter } from './all-exceptions.filter.js'
import { defaultHttpErrorCode } from './default-http-error-code.map.js'
import type { ExceptionTranslator } from './exception-translator.js'

type FakeRequestInit = {
  method?: string
  path?: string
  headers?: Record<string, string>
  correlationId?: string
}

/** Request mínimo: lo que leen el filtro y `resolveCorrelationId` (cabeceras por las tres vías de Express). */
function fakeRequest({
  method = 'GET',
  path = '/api/v1/probe',
  headers = {},
  correlationId,
}: FakeRequestInit = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  const read = (name: string) => lower[name.toLowerCase()]
  return {
    method,
    path,
    url: path,
    originalUrl: path,
    headers: lower,
    rawHeaders: Object.entries(headers).flat(),
    get: read,
    header: read,
    ...(correlationId === undefined ? {} : { correlationId }),
  } as unknown as Request
}

type Sent = { status?: number; body?: unknown; headers: Record<string, string>; destroyed: boolean }

function run(
  exception: unknown,
  request: Request = fakeRequest({ correlationId: 'corr-1' }),
  headersSent = false,
  filter: AllExceptionsFilter = new AllExceptionsFilter(),
): Sent {
  const sent: Sent = { headers: {}, destroyed: false }
  const response = {
    headersSent,
    setHeader(name: string, value: string) {
      sent.headers[name.toLowerCase()] = value
      return response
    },
    status(code: number) {
      sent.status = code
      return response
    },
    json(body: unknown) {
      sent.body = JSON.parse(JSON.stringify(body))
      return response
    },
    destroy() {
      sent.destroyed = true
    },
  }
  const host = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ArgumentsHost
  filter.catch(exception, host)
  return sent
}

/** Comprueba el sobre contra `apiErrorEnvelopeSchema`, el estado del código y el mensaje en español. */
function expectEnvelope(sent: Sent, code: ApiErrorCode) {
  const parsed = apiErrorEnvelopeSchema.safeParse(sent.body)
  expect(parsed.error?.issues ?? []).toEqual([])
  const body = sent.body as {
    code: string
    statusCode: number
    message: string
    correlationId: string
  }
  expect(body.code).toBe(code)
  expect(sent.status).toBe(API_ERROR_HTTP_STATUS[code])
  expect(body.statusCode).toBe(sent.status)
  expect(sent.headers['x-correlation-id']).toBe(body.correlationId)
  return body
}

let loggedErrors: MockInstance

beforeEach(() => {
  loggedErrors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('AllExceptionsFilter: errores de la aplicación', () => {
  it('ApiError sale con su código, su estado y su mensaje', () => {
    const body = expectEnvelope(run(apiError('CAPTCHA_FAILED')), 'CAPTCHA_FAILED')
    expect(body.message).toBe(API_ERROR_MESSAGES_ES.CAPTCHA_FAILED)
    expect(body.correlationId).toBe('corr-1')
    expect(loggedErrors).not.toHaveBeenCalled()
  })

  it('ApiValidationError lleva details.violations', () => {
    const sent = run(
      new ApiValidationError([{ field: 'contact.email', messages: ['El correo no es válido.'] }]),
    )
    expectEnvelope(sent, 'VALIDATION_ERROR')
    expect(sent.body).toMatchObject({
      details: { violations: [{ field: 'contact.email', messages: ['El correo no es válido.'] }] },
    })
  })

  it('BusinessRulesViolatedError lleva details.problems', () => {
    const problems = [createProblem('NO_INVOICES')]
    const sent = run(new BusinessRulesViolatedError(problems))
    expectEnvelope(sent, 'BUSINESS_RULES_VIOLATED')
    expect(sent.body).toMatchObject({ details: { problems } })
  })

  it('ServiceUnavailableError es 503 sin el diagnóstico y queda en el log', () => {
    const sent = run(new ServiceUnavailableError('la base no respondió en 5000 ms'))
    const body = expectEnvelope(sent, 'SERVICE_UNAVAILABLE')
    expect(JSON.stringify(body)).not.toContain('5000 ms')
    expect(loggedErrors).toHaveBeenCalledTimes(1)
  })

  it('otra clase con VALIDATION_ERROR recibe la observación genérica, nunca un 500', () => {
    class OtherValidationError extends ApplicationError<'VALIDATION_ERROR'> {
      constructor() {
        super('VALIDATION_ERROR')
      }
    }
    const sent = run(new OtherValidationError())
    expectEnvelope(sent, 'VALIDATION_ERROR')
    expect(sent.body).toMatchObject({
      details: { violations: [{ field: '$', messages: [API_ERROR_MESSAGES_ES.VALIDATION_ERROR] }] },
    })
  })

  it('BUSINESS_RULES_VIOLATED sin problemas es un defecto: 500 con log', () => {
    class EmptyRulesError extends ApplicationError<'BUSINESS_RULES_VIOLATED'> {
      constructor() {
        super('BUSINESS_RULES_VIOLATED')
      }
    }
    expectEnvelope(run(new EmptyRulesError()), 'INTERNAL_ERROR')
    expect(loggedErrors).toHaveBeenCalledTimes(1)
  })

  it.each(API_ERROR_CODES)('%s responde con el estado de API_ERROR_HTTP_STATUS', (code) => {
    const error =
      code === 'VALIDATION_ERROR'
        ? new ApiValidationError([])
        : code === 'BUSINESS_RULES_VIOLATED'
          ? new BusinessRulesViolatedError([createProblem('NO_INVOICES')])
          : apiError(code)
    const body = expectEnvelope(run(error), code)
    expect(body.message).toBe(API_ERROR_MESSAGES_ES[code])
  })
})

describe('AllExceptionsFilter: excepciones de Nest y de librerías', () => {
  const LEAK = 'leaked english detail'

  it.each([
    ['BadRequestException', 'BAD_REQUEST', new BadRequestException(LEAK)],
    ['UnauthorizedException', 'BAD_REQUEST', new UnauthorizedException(LEAK)],
    ['ForbiddenException', 'BAD_REQUEST', new ForbiddenException(LEAK)],
    ['NotFoundException', 'RESOURCE_NOT_FOUND', new NotFoundException(`Cannot GET /x ${LEAK}`)],
    ['MethodNotAllowedException', 'BAD_REQUEST', new MethodNotAllowedException(LEAK)],
    ['ConflictException', 'CONFLICT', new ConflictException(LEAK)],
    ['HttpException 411', 'LENGTH_REQUIRED', new HttpException(LEAK, 411)],
    ['PayloadTooLargeException', 'PAYLOAD_TOO_LARGE', new PayloadTooLargeException(LEAK)],
    ['UnsupportedMediaTypeException', 'BAD_REQUEST', new UnsupportedMediaTypeException(LEAK)],
    ['UnprocessableEntityException', 'BAD_REQUEST', new UnprocessableEntityException(LEAK)],
    ['HttpException 429', 'RATE_LIMIT_EXCEEDED', new HttpException(`Too many ${LEAK}`, 429)],
    ['ThrottlerException', 'RATE_LIMIT_EXCEEDED', new ThrottlerException()],
    ['InternalServerErrorException', 'INTERNAL_ERROR', new InternalServerErrorException(LEAK)],
    ['NotImplementedException', 'INTERNAL_ERROR', new NotImplementedException(LEAK)],
    ['BadGatewayException', 'INTERNAL_ERROR', new BadGatewayException(LEAK)],
    ['ServiceUnavailableException', 'SERVICE_UNAVAILABLE', new ServiceUnavailableException(LEAK)],
  ] as const)('%s sale como %s, con el mensaje en español', (_label, code, exception) => {
    const body = expectEnvelope(run(exception), code)
    expect(body.message).toBe(API_ERROR_MESSAGES_ES[code])
    expect(JSON.stringify(body)).not.toMatch(/leaked english|Too Many Requests|Cannot GET/i)
  })

  it.each([
    ['entity.parse.failed', 400, 'MALFORMED_JSON'],
    ['entity.too.large', 413, 'PAYLOAD_TOO_LARGE'],
    ['charset.unsupported', 415, 'BAD_REQUEST'],
    ['stream.not.readable', 500, 'INTERNAL_ERROR'],
  ] as const)('el error de body-parser %s (%i) sale como %s', (type, status, code) => {
    const parserError = Object.assign(new Error(`parser said ${type}`), {
      status,
      statusCode: status,
      type,
    })
    const body = expectEnvelope(run(parserError), code)
    expect(JSON.stringify(body)).not.toContain('parser said')
  })

  it('un error cualquiera es 500 sin detalles internos y queda en el log', () => {
    const body = expectEnvelope(run(new Error('secreto interno: password=123')), 'INTERNAL_ERROR')
    expect(JSON.stringify(body)).not.toContain('secreto')
    expect(loggedErrors).toHaveBeenCalledTimes(1)
  })

  it.each([['un texto'], [null], [undefined], [42]])('lanzar %o también es 500', (thrown) => {
    expectEnvelope(run(thrown), 'INTERNAL_ERROR')
  })
})

describe('AllExceptionsFilter: traductores de errores de infraestructura', () => {
  /** Error de una librería que un traductor reconoce (como el de la base caída). */
  class DriverDownError extends Error {
    override readonly name = 'DriverDownError'
    readonly code = 'DRIVER_DOWN'
  }
  const translateDriverDown: ExceptionTranslator = (exception) =>
    exception instanceof DriverDownError
      ? new ServiceUnavailableError('el driver no responde', { cause: exception })
      : undefined
  const withTranslators = (...translators: ExceptionTranslator[]) =>
    new AllExceptionsFilter(translators)
  const runWith = (exception: unknown, ...translators: ExceptionTranslator[]) =>
    run(exception, fakeRequest({ correlationId: 'corr-1' }), false, withTranslators(...translators))

  it('un error que un traductor reconoce sale como su ApplicationError: 503, no 500', () => {
    const body = expectEnvelope(
      runWith(new DriverDownError('host 10.0.0.5 caído'), translateDriverDown),
      'SERVICE_UNAVAILABLE',
    )
    expect(body.message).toBe(API_ERROR_MESSAGES_ES.SERVICE_UNAVAILABLE)
    expect(JSON.stringify(body)).not.toMatch(/10\.0\.0\.5|driver|DRIVER_DOWN/i)
  })

  it('el log registra el error original (su clase y su código), con el código y el estado públicos', () => {
    const original = new DriverDownError('host caído')
    runWith(original, translateDriverDown)
    expect(loggedErrors).toHaveBeenCalledTimes(1)
    expect(loggedErrors).toHaveBeenCalledWith(
      expect.objectContaining({ err: original, code: 'SERVICE_UNAVAILABLE', statusCode: 503 }),
      'Respuesta 503 SERVICE_UNAVAILABLE',
    )
  })

  it('lo que ningún traductor reconoce sigue siendo 500 INTERNAL_ERROR', () => {
    expectEnvelope(runWith(new Error('defecto'), translateDriverDown), 'INTERNAL_ERROR')
  })

  it('gana el primer traductor que reconoce el error', () => {
    const second = vi.fn<ExceptionTranslator>(() => apiError('CONFLICT'))
    expectEnvelope(
      runWith(new DriverDownError('x'), translateDriverDown, second),
      'SERVICE_UNAVAILABLE',
    )
    expect(second).not.toHaveBeenCalled()
  })

  it('una ApplicationError o una HttpException no pasan por los traductores', () => {
    const translator = vi.fn<ExceptionTranslator>(() => new ServiceUnavailableError())
    expectEnvelope(runWith(apiError('CAPTCHA_FAILED'), translator), 'CAPTCHA_FAILED')
    expectEnvelope(runWith(new NotFoundException(), translator), 'RESOURCE_NOT_FOUND')
    expect(translator).not.toHaveBeenCalled()
  })

  it('un traductor que lanza no impide responder: se ignora y el error sigue su camino', () => {
    const broken: ExceptionTranslator = () => {
      throw new TypeError('traductor roto')
    }
    expectEnvelope(
      runWith(new DriverDownError('x'), broken, translateDriverDown),
      'SERVICE_UNAVAILABLE',
    )
    expectEnvelope(runWith(new Error('defecto'), broken), 'INTERNAL_ERROR')
  })
})

describe('AllExceptionsFilter: salud', () => {
  const failed = {
    status: 'error',
    info: {},
    error: { database: { status: 'down' } },
    details: { database: { status: 'down' } },
  }

  it.each(['/health', '/health/readiness'])(
    'en %s devuelve el cuerpo de Terminus con 503',
    (path) => {
      const sent = run(
        new ServiceUnavailableException(failed),
        fakeRequest({ path, correlationId: 'c' }),
      )
      expect(sent.status).toBe(503)
      expect(sent.body).toEqual(failed)
      expect(sent.headers['x-correlation-id']).toBe('c')
    },
  )

  it('también mientras la app se apaga', () => {
    const shuttingDown = { status: 'shutting_down', info: {}, error: {}, details: {} }
    const sent = run(
      new ServiceUnavailableException(shuttingDown),
      fakeRequest({ path: '/health' }),
    )
    expect(sent.body).toEqual(shuttingDown)
  })

  it('fuera de /health, o con otro cuerpo, responde con el sobre', () => {
    expectEnvelope(run(new ServiceUnavailableException(failed)), 'SERVICE_UNAVAILABLE')
    expectEnvelope(
      run(
        new ServiceUnavailableException({ status: 'error', extra: 1 }),
        fakeRequest({ path: '/health' }),
      ),
      'SERVICE_UNAVAILABLE',
    )
  })
})

describe('AllExceptionsFilter: correlation id y respuesta ya enviada', () => {
  it('sin correlation id en la solicitud, usa el de la cabecera o genera uno', () => {
    const fromHeader = run(
      apiError('CONFLICT'),
      fakeRequest({ headers: { 'x-correlation-id': 'cliente-42' } }),
    )
    expect(expectEnvelope(fromHeader, 'CONFLICT').correlationId).toBe('cliente-42')
    const generated = run(apiError('CONFLICT'), fakeRequest())
    expect(expectEnvelope(generated, 'CONFLICT').correlationId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('si la respuesta ya empezó, corta la conexión sin escribir otra', () => {
    const sent = run(
      new Error('falló a mitad de la respuesta'),
      fakeRequest({ correlationId: 'c' }),
      true,
    )
    expect(sent.destroyed).toBe(true)
    expect(sent.status).toBeUndefined()
    expect(sent.body).toBeUndefined()
    expect(loggedErrors).toHaveBeenCalledTimes(1)
  })
})

describe('defaultHttpErrorCode', () => {
  it.each([
    [400, 'BAD_REQUEST'],
    [401, 'BAD_REQUEST'],
    [404, 'RESOURCE_NOT_FOUND'],
    [405, 'BAD_REQUEST'],
    [409, 'CONFLICT'],
    [411, 'LENGTH_REQUIRED'],
    [413, 'PAYLOAD_TOO_LARGE'],
    [418, 'BAD_REQUEST'],
    [429, 'RATE_LIMIT_EXCEEDED'],
    [500, 'INTERNAL_ERROR'],
    [502, 'INTERNAL_ERROR'],
    [503, 'SERVICE_UNAVAILABLE'],
    [302, 'INTERNAL_ERROR'],
  ] as const)('%i → %s', (status, code) => {
    expect(defaultHttpErrorCode(status)).toBe(code)
  })
})
