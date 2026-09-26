import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { type Options, pinoHttp } from 'pino-http'
import { describe, expect, it } from 'vitest'
import {
  createPinoHttpOptions,
  isHealthRequest,
  resolveHttpLogLevel,
  resolveLogRoute,
  serializeSafeError,
  serializeSafeRequest,
  serializeSafeResponse,
} from './pino-http.options.js'

const response = (statusCode: number) => ({ statusCode }) as ServerResponse
const request = (url: string, headers: Record<string, string> = {}) =>
  ({ url, headers }) as unknown as IncomingMessage

describe('logger HTTP', () => {
  it('registra 5xx y errores como error, 4xx como warn y el resto como info', () => {
    const req = request('/api/v1/payers')
    expect(resolveHttpLogLevel(req, response(503))).toBe('error')
    expect(resolveHttpLogLevel(req, response(200), new Error('se cortó'))).toBe('error')
    expect(resolveHttpLogLevel(req, response(422))).toBe('warn')
    expect(resolveHttpLogLevel(req, response(201))).toBe('info')
  })

  it('no deja pasar URL, cabeceras, IP ni mensajes de error al log', () => {
    expect(
      serializeSafeRequest({
        method: 'POST',
        url: '/api/v1/advance-requests?email=ana@proveedor.pe',
        headers: { cookie: 'x' },
        remoteAddress: '203.0.113.7',
      }),
    ).toEqual({ method: 'POST' })
    expect(serializeSafeRequest({ method: 'post; drop' })).toEqual({ method: 'UNKNOWN' })
    expect(serializeSafeResponse({ statusCode: 201, headers: { 'set-cookie': 'x' } })).toEqual({
      statusCode: 201,
    })
    const error = Object.assign(new Error('Key (email)=(ana@proveedor.pe) already exists'), {
      code: '23505',
    })
    expect(serializeSafeError(error)).toEqual({ type: 'Error', code: '23505' })
  })

  it('con pino-http real el error llega envuelto por su serializador y conserva clase y código', () => {
    // pino-http envuelve el serializador `err`: recibe el objeto de pino-std-serializers (con el
    // error en `raw`), no el Error. Sin verlo así, todo error del log salía como { type: 'Error' }.
    const lines: string[] = []
    const { pinoHttp: options } = createPinoHttpOptions({ logLevel: 'error', nodeEnv: 'test' })
    const http = pinoHttp(options as Options, {
      write: (line: string) => {
        lines.push(line)
      },
    })
    const error = Object.assign(
      new Error("Can't reach database server at db.interno:5432 (ana@proveedor.pe)"),
      { name: 'PrismaClientKnownRequestError', code: 'P1001', meta: { modelName: 'Payer' } },
    )
    http.logger.error({ err: error }, 'Respuesta 503 SERVICE_UNAVAILABLE')
    http.logger.error({ err: 'un texto' }, 'lanzaron un texto')
    const [entry, text] = lines.map((line) => JSON.parse(line) as { err: unknown })
    expect(entry?.err).toEqual({ type: 'PrismaClientKnownRequestError', code: 'P1001' })
    expect(text?.err).toEqual({ type: 'Error' })
    expect(lines.join('')).not.toMatch(/db\.interno|ana@proveedor|Payer|stack/)
  })

  it('registra el patrón de la ruta, nunca la URL ni el comodín del 404', () => {
    const routed = (path: string) =>
      Object.assign(request('/api/v1/payers?x=1'), { baseUrl: '', route: { path } })
    expect(resolveLogRoute(routed('/api/v1/payers'))).toBe('/api/v1/payers')
    expect(resolveLogRoute(routed('/api*path'))).toBeUndefined()
    expect(resolveLogRoute(request('/api/v1/payers'))).toBeUndefined()
  })

  it('no registra las sondas de salud', () => {
    expect(isHealthRequest(request('/health'))).toBe(true)
    expect(isHealthRequest(request('/health/readiness?full=1'))).toBe(true)
    expect(isHealthRequest(request('/api/v1/health'))).toBe(false)
  })

  it('usa el id de correlación como id de la petición y pino-pretty solo en desarrollo', () => {
    const options = createPinoHttpOptions({ logLevel: 'info', nodeEnv: 'test' })
    const pinoHttp = options.pinoHttp as {
      genReqId: (req: IncomingMessage, res: ServerResponse) => string
      transport?: unknown
    }
    const req = request('/api/v1/payers', { 'x-correlation-id': 'pedido-9' })
    expect(pinoHttp.genReqId(req, response(200))).toBe('pedido-9')
    expect(pinoHttp.transport).toBeUndefined()
    const development = createPinoHttpOptions({ logLevel: 'debug', nodeEnv: 'development' })
    expect(development.pinoHttp).toMatchObject({
      level: 'debug',
      transport: { target: 'pino-pretty' },
    })
  })

  it('cada línea lleva el correlationId una sola vez, y la de cierre también la ruta', () => {
    // pino-http vuelve a llamar a customProps al cerrar la respuesta: si lo que devuelve cambió
    // (la ruta se conoce recién después de enrutar), agrega un hijo con todo y el correlationId
    // salía dos veces en la misma línea.
    const lines: string[] = []
    const { pinoHttp: options } = createPinoHttpOptions({ logLevel: 'info', nodeEnv: 'test' })
    const middleware = pinoHttp(options as Options, {
      write: (line: string) => {
        lines.push(line)
      },
    })
    for (const status of [200, 422, 500]) {
      const req = new IncomingMessage(new Socket())
      req.method = 'GET'
      req.url = '/api/v1/payers'
      req.headers = { 'x-correlation-id': `pedido-${status}` }
      const res = new ServerResponse(req)
      middleware(req, res, () => undefined)
      req.log.info({ paso: 'handler' }, 'dentro de la petición')
      Object.assign(req, { baseUrl: '', route: { path: '/api/v1/payers' } })
      res.statusCode = status
      res.emit('finish')
    }
    expect(lines).toHaveLength(6)
    for (const line of lines) {
      expect(line.match(/"correlationId"/g), line).toHaveLength(1)
    }
    const closing = lines.filter((_line, index) => index % 2 === 1).map((line) => JSON.parse(line))
    expect(closing.map((entry) => [entry.correlationId, entry.route])).toEqual([
      ['pedido-200', '/api/v1/payers'],
      ['pedido-422', '/api/v1/payers'],
      ['pedido-500', '/api/v1/payers'],
    ])
  })
})
