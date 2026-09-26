import type { Server } from 'node:http'
import { Body, Controller, Get, HttpCode, Inject, Logger, Module, Post, Req } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import type { Request } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { APP_CONFIG, type AppConfig } from '#/common/config/index.js'
import { SubmitThrottle } from '#/common/decorators/submit-throttle.decorator.js'
import { CLOCK, type Clock } from '#/common/time/clock.js'
import { resolveClientIp } from '#/common/utils/client-ip.js'
import { createTestApp, TEST_NOW } from '../test/support/app.js'

@Controller({ path: 'probe', version: '1' })
class ProbeController {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  read(@Req() req: Request) {
    return {
      correlationId: req.correlationId,
      clientIp: resolveClientIp(req, this.config.trustCloudflareHeaders),
      now: this.clock.now().toISOString(),
    }
  }

  @Post('json')
  @HttpCode(200)
  json(@Body() body: unknown) {
    return { received: typeof body === 'object' && body !== null }
  }

  @Post('submit')
  @HttpCode(200)
  @SubmitThrottle()
  submit() {
    return { ok: true }
  }
}

/** Sin `version`: toma la versión por defecto de la app. */
@Controller('unversioned')
class UnversionedController {
  @Get()
  read() {
    return { ok: true }
  }
}

@Module({ controllers: [ProbeController, UnversionedController] })
class ProbeModule {}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Un entorno de producción válido (https, correo real y clave de Turnstile que no es de prueba). */
const PRODUCTION_ENV = {
  NODE_ENV: 'production',
  CORS_ORIGINS: 'https://anticipate.pe',
  S3_ENDPOINT: 'https://cuenta.r2.cloudflarestorage.com',
  MAIL_TRANSPORT: 'brevo',
  BREVO_API_KEY: 'xkeysib-clave-de-produccion',
  ADMIN_BASE_URL: 'https://admin.anticipate.pe',
  TURNSTILE_SECRET_KEY: '0x4AAAAAAAclave-de-produccion',
}

describe('setupApp', () => {
  let app: NestExpressApplication
  let http: Server

  beforeAll(async () => {
    app = await createTestApp({ extraModules: [ProbeModule] })
    http = app.getHttpServer()
  })

  afterAll(async () => {
    await app.close()
  })

  it('GET /health responde el cuerpo de Terminus, sin prefijo ni versión y sin caché', async () => {
    const res = await request(http).get('/health').expect(200)
    expect(res.body).toEqual({
      status: 'ok',
      info: { process: { status: 'up' } },
      error: {},
      details: { process: { status: 'up' } },
    })
    expect(res.headers['cache-control']).toContain('no-cache')
  })

  it('las sondas no existen con el prefijo ni con versión', async () => {
    for (const path of ['/api/health', '/api/v1/health', '/v1/health']) {
      await request(http).get(path).expect(404)
    }
  })

  it('las rutas de negocio llevan el prefijo api y la versión 1', async () => {
    await request(http).get('/api/v1/probe').expect(200)
    await request(http).get('/api/v1/unversioned').expect(200)
    for (const path of ['/probe', '/api/probe', '/v1/probe', '/api/v2/probe']) {
      await request(http).get(path).expect(404)
    }
  })

  it('conserva el x-correlation-id recibido y lo deja en req.correlationId', async () => {
    const res = await request(http)
      .get('/api/v1/probe')
      .set('x-correlation-id', 'pedido-123.A_b')
      .expect(200)
    expect(res.headers['x-correlation-id']).toBe('pedido-123.A_b')
    expect(res.body.correlationId).toBe('pedido-123.A_b')
  })

  it('genera un UUID si la cabecera falta o no cumple el formato, también en un 404 y en /health', async () => {
    const missing = await request(http).get('/api/v1/probe').expect(200)
    expect(missing.headers['x-correlation-id']).toMatch(UUID_V4)
    expect(missing.body.correlationId).toBe(missing.headers['x-correlation-id'])
    const invalid = await request(http).get('/api/v1/probe').set('x-correlation-id', 'con espacio')
    expect(invalid.headers['x-correlation-id']).toMatch(UUID_V4)
    const notFound = await request(http).get('/no-existe').expect(404)
    expect(notFound.headers['x-correlation-id']).toMatch(UUID_V4)
    const health = await request(http).get('/health').expect(200)
    expect(health.headers['x-correlation-id']).toMatch(UUID_V4)
  })

  it('agrega las cabeceras de helmet y no anuncia Express', async () => {
    const res = await request(http).get('/api/v1/probe').expect(200)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN')
    expect(res.headers['x-powered-by']).toBeUndefined()
  })

  it('CORS responde solo a los orígenes configurados y expone las cabeceras propias', async () => {
    const allowed = await request(http).get('/api/v1/probe').set('origin', 'http://localhost:4321')
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:4321')
    expect(allowed.headers['access-control-expose-headers']).toBe(
      'x-correlation-id,idempotent-replayed,Retry-After',
    )
    const other = await request(http).get('/api/v1/probe').set('origin', 'https://otro.example')
    expect(other.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('el preflight admite las cabeceras del envío de solicitudes', async () => {
    const res = await request(http)
      .options('/api/v1/probe/submit')
      .set('origin', 'http://localhost:4321')
      .set('access-control-request-method', 'POST')
      .set('access-control-request-headers', 'content-type,idempotency-key,x-turnstile-token')
      .expect(204)
    expect(res.headers['access-control-allow-headers']).toBe(
      'Content-Type,x-correlation-id,idempotency-key,x-turnstile-token',
    )
    expect(res.headers['access-control-max-age']).toBe('600')
    expect(res.headers['x-correlation-id']).toMatch(UUID_V4)
  })

  it('acepta JSON hasta el tope y corta con 413 lo que lo supera, sin llegar al controlador', async () => {
    const small = await request(http).post('/api/v1/probe/json').send({ ok: true }).expect(200)
    expect(small.body.data).toEqual({ received: true })
    const tooLarge = await request(http)
      .post('/api/v1/probe/json')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ relleno: 'a'.repeat(300 * 1024) }))
      .expect(413)
    // El id de correlación se fija antes que el parser: también sale en su rechazo.
    expect(tooLarge.headers['x-correlation-id']).toMatch(UUID_V4)
  })

  it('el reloj de la app es el de la prueba', async () => {
    const res = await request(http).get('/api/v1/probe').expect(200)
    expect(res.body.data.now).toBe(TEST_NOW.toISOString())
  })

  it('aplica al servidor HTTP los tiempos de la configuración', () => {
    expect(http.requestTimeout).toBe(120_000)
    expect(http.headersTimeout).toBe(20_000)
    expect(http.keepAliveTimeout).toBe(65_000)
  })

  it('sirve Swagger fuera de producción con las rutas reales', async () => {
    const res = await request(http).get('/docs-json').expect(200)
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining(['/health', '/api/v1/probe', '/api/v1/probe/submit']),
    )
  })
})

describe('límites de peticiones', () => {
  it('el límite general corta con 429 y Retry-After, y nunca a /health', async () => {
    const app = await createTestApp({
      env: { THROTTLE_DEFAULT_LIMIT: '2' },
      extraModules: [ProbeModule],
    })
    try {
      const http = app.getHttpServer()
      await request(http).get('/api/v1/probe').expect(200)
      await request(http).get('/api/v1/probe').expect(200)
      const limited = await request(http).get('/api/v1/probe').expect(429)
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
      for (let i = 0; i < 5; i++) await request(http).get('/health').expect(200)
    } finally {
      await app.close()
    }
  })

  it('el límite de envíos solo cuenta en las rutas con @SubmitThrottle()', async () => {
    const app = await createTestApp({
      env: { THROTTLE_SUBMIT_LIMIT: '1' },
      extraModules: [ProbeModule],
    })
    try {
      const http = app.getHttpServer()
      await request(http).post('/api/v1/probe/submit').expect(200)
      const limited = await request(http).post('/api/v1/probe/submit').expect(429)
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(3_500)
      for (let i = 0; i < 3; i++) await request(http).get('/api/v1/probe').expect(200)
    } finally {
      await app.close()
    }
  })

  it('cuenta por la IP real: con TRUST_CLOUDFLARE_HEADERS cada CF-Connecting-IP tiene su cupo', async () => {
    const app = await createTestApp({
      env: { THROTTLE_SUBMIT_LIMIT: '1', TRUST_CLOUDFLARE_HEADERS: 'true' },
      extraModules: [ProbeModule],
    })
    try {
      const http = app.getHttpServer()
      const submitFrom = (ip: string) =>
        request(http).post('/api/v1/probe/submit').set('cf-connecting-ip', ip)
      await submitFrom('203.0.113.1').expect(200)
      await submitFrom('203.0.113.1').expect(429)
      await submitFrom('203.0.113.2').expect(200)
    } finally {
      await app.close()
    }
  })

  it('TRUST_PROXY decide si se cree X-Forwarded-For', async () => {
    const behindProxy = await createTestApp({ extraModules: [ProbeModule] })
    const direct = await createTestApp({
      env: { TRUST_PROXY: 'false' },
      extraModules: [ProbeModule],
    })
    try {
      const fromProxy = await request(behindProxy.getHttpServer())
        .get('/api/v1/probe')
        .set('x-forwarded-for', '203.0.113.7')
      expect(fromProxy.body.data.clientIp).toBe('203.0.113.7')
      const fromClient = await request(direct.getHttpServer())
        .get('/api/v1/probe')
        .set('x-forwarded-for', '203.0.113.7')
      expect(fromClient.body.data.clientIp).toMatch(/127\.0\.0\.1$/)
    } finally {
      await behindProxy.close()
      await direct.close()
    }
  })
})

describe('aviso de la IP del cliente mal configurada', () => {
  it('detrás de un proxy que TRUST_PROXY no reconoce, o con Cloudflare ignorado, registra un error una vez por problema', async () => {
    const errors = vi.spyOn(Logger.prototype, 'error')
    const app = await createTestApp({ env: { TRUST_PROXY: 'false' }, extraModules: [ProbeModule] })
    try {
      const http = app.getHttpServer()
      const misconfigurations = () =>
        errors.mock.calls
          .map(([context]) => (context as { misconfiguration?: string }).misconfiguration)
          .filter((kind) => kind !== undefined)
      // Las sondas no se revisan: el monitoreo puede llegar por el proxy sin pasar por Cloudflare.
      await request(http).get('/health').set('x-forwarded-for', '203.0.113.7').expect(200)
      expect(misconfigurations()).toEqual([])
      for (let n = 0; n < 3; n += 1) {
        const res = await request(http)
          .get('/api/v1/probe')
          .set('x-forwarded-for', '203.0.113.7')
          .expect(200)
        expect(res.body.data.clientIp).toMatch(/127\.0\.0\.1$/)
      }
      await request(http).get('/api/v1/probe').set('cf-connecting-ip', '203.0.113.8').expect(200)
      await request(http).get('/api/v1/probe').set('cf-connecting-ip', '203.0.113.9').expect(200)
      expect(misconfigurations()).toEqual(['forwarded-for-untrusted', 'cloudflare-header-ignored'])
      expect(JSON.stringify(errors.mock.calls)).not.toContain('203.0.113')
    } finally {
      errors.mockRestore()
      await app.close()
    }
  })

  it('con la IP bien resuelta no registra nada', async () => {
    const errors = vi.spyOn(Logger.prototype, 'error')
    const app = await createTestApp({
      env: { TRUST_CLOUDFLARE_HEADERS: 'true' },
      extraModules: [ProbeModule],
    })
    try {
      const res = await request(app.getHttpServer())
        .get('/api/v1/probe')
        .set('cf-connecting-ip', '203.0.113.8')
        .set('x-forwarded-for', '203.0.113.8')
        .expect(200)
      expect(res.body.data.clientIp).toBe('203.0.113.8')
      expect(errors).not.toHaveBeenCalled()
    } finally {
      errors.mockRestore()
      await app.close()
    }
  })
})

describe('en producción', () => {
  it('no sirve Swagger y agrega HSTS', async () => {
    const app = await createTestApp({ env: PRODUCTION_ENV })
    try {
      const http = app.getHttpServer()
      await request(http).get('/docs').expect(404)
      await request(http).get('/docs-json').expect(404)
      const health = await request(http).get('/health').expect(200)
      expect(health.headers['strict-transport-security']).toContain('max-age=')
    } finally {
      await app.close()
    }
  })
})
