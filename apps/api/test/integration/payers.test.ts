import {
  apiErrorEnvelopeSchema,
  apiSuccessEnvelopeSchema,
  DEFAULT_SUCCESS_MESSAGE,
} from '@anticipate/shared/api'
import { publicPayerSchema } from '@anticipate/shared/payer'
import { Logger } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CORRELATION_ID_HEADER } from '#/common/constants/http-headers.constants.js'
import type { Prisma } from '#/infrastructure/prisma/generated/client.js'
import { PAYER_REPOSITORY, type Payer, type PayerRepositoryPort } from '#/modules/payers/index.js'
import { PUBLIC_PAYERS_CACHE_CONTROL } from '#/modules/payers/presentation/http/constants/public-payers.constants.js'
import { createTestApp } from '../support/app.js'
import { createTestPrisma, truncateAll } from '../support/db.js'
import { createPayer, SEA } from '../support/factories.js'

const PAYERS_PATH = '/api/v1/payers'
const payersEnvelopeSchema = apiSuccessEnvelopeSchema(publicPayerSchema.array())
const PUBLIC_PAYER_KEYS = [
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
]

/** Pagador activo con porcentaje de dos decimales, logo y dos textos; cumple todas las CHECK de payers. */
const AGRO_ANDINA = {
  slug: 'agro-andina',
  ruc: '20100070970',
  legalName: 'Agro Andina S.A.C.',
  shortName: 'Agro Andina',
  advancePercent: '33.33',
  minTermDays: 30,
  maxInvoices: 5,
  allowedCurrencies: ['PEN'],
  accentColor: '#1D4ED8',
  logoUrl: 'https://cdn.anticipate.pe/agro-andina.svg',
  texts: { title: 'Adelanta tus facturas a Agro Andina', subtitle: 'Te abonamos en 48 horas' },
} satisfies Prisma.PayerCreateInput

describe('GET /api/v1/payers contra la base', () => {
  const db = createTestPrisma()
  let app: NestExpressApplication

  beforeAll(async () => {
    app = await createTestApp()
  })

  beforeEach(async () => {
    await truncateAll(db.prisma)
  })

  afterAll(async () => {
    await app.close()
    await db.close()
  })

  it('devuelve en el sobre solo los activos, ordenados por nombre corto y con sus campos públicos', async () => {
    await createPayer(db.prisma)
    await db.prisma.payer.create({ data: AGRO_ANDINA })
    await db.prisma.payer.create({
      data: {
        ...AGRO_ANDINA,
        slug: 'retirado',
        ruc: '20100047218',
        legalName: 'Retirado S.A.C.',
        shortName: 'Retirado',
        active: false,
      },
    })

    const res = await request(app.getHttpServer())
      .get(PAYERS_PATH)
      .set(CORRELATION_ID_HEADER, 'landing-build-1')
      .expect(200)

    expect(payersEnvelopeSchema.safeParse(res.body).success).toBe(true)
    expect(res.body).toMatchObject({
      success: true,
      statusCode: 200,
      message: DEFAULT_SUCCESS_MESSAGE,
      correlationId: 'landing-build-1',
    })
    expect(res.body).not.toHaveProperty('metadataPagination')
    expect(res.headers[CORRELATION_ID_HEADER]).toBe('landing-build-1')
    expect(res.headers['cache-control']).toBe('public, max-age=300')
    expect(res.body.data).toEqual([
      {
        slug: 'agro-andina',
        ruc: '20100070970',
        legalName: 'Agro Andina S.A.C.',
        shortName: 'Agro Andina',
        advancePercent: 33.33,
        minTermDays: 30,
        maxInvoices: 5,
        allowedCurrencies: ['PEN'],
        accentColor: '#1D4ED8',
        logoUrl: 'https://cdn.anticipate.pe/agro-andina.svg',
        texts: {
          title: 'Adelanta tus facturas a Agro Andina',
          subtitle: 'Te abonamos en 48 horas',
        },
      },
      {
        slug: SEA.slug,
        ruc: SEA.ruc,
        legalName: SEA.legalName,
        shortName: SEA.shortName,
        advancePercent: Number(SEA.advancePercent),
        minTermDays: SEA.minTermDays,
        maxInvoices: SEA.maxInvoices,
        allowedCurrencies: [...SEA.allowedCurrencies],
        accentColor: SEA.accentColor,
        logoUrl: SEA.logoUrl,
        texts: SEA.texts,
      },
    ])
    for (const payer of res.body.data) {
      expect(Object.keys(payer).sort()).toEqual(PUBLIC_PAYER_KEYS)
    }
  })

  it('sin pagadores activos responde la lista vacía en el sobre', async () => {
    await db.prisma.payer.create({ data: { ...AGRO_ANDINA, active: false } })

    const res = await request(app.getHttpServer()).get(PAYERS_PATH).expect(200)

    expect(payersEnvelopeSchema.safeParse(res.body).success).toBe(true)
    expect(res.body.data).toEqual([])
    expect(res.headers['cache-control']).toBe(PUBLIC_PAYERS_CACHE_CONTROL)
    expect(res.headers[CORRELATION_ID_HEADER]).toBe(res.body.correlationId)
  })

  it('la ruta existe solo con prefijo y versión', async () => {
    await request(app.getHttpServer()).get('/payers').expect(404)
    const res = await request(app.getHttpServer()).get('/api/payers').expect(404)
    expect(apiErrorEnvelopeSchema.safeParse(res.body).success).toBe(true)
    expect(res.body.code).toBe('RESOURCE_NOT_FOUND')
  })
})

describe('GET /api/v1/payers con el repositorio reemplazado', () => {
  const listActive = vi.fn<PayerRepositoryPort['listActive']>()
  let app: NestExpressApplication

  const sea: Payer = {
    id: '01890a5d-ac96-774b-bcce-b302099a8057',
    slug: 'sea',
    ruc: '20131312955',
    legalName: 'Servicios Energéticos Ambientales S.A.',
    shortName: 'SEA',
    advancePercent: 80,
    minTermDays: 15,
    maxInvoices: 10,
    allowedCurrencies: ['PEN', 'USD'],
    accentColor: '#0E7C86',
    logoUrl: null,
    texts: { title: 'Adelanta tus facturas a SEA' },
  }

  beforeAll(async () => {
    app = await createTestApp({ overrides: [[PAYER_REPOSITORY, { listActive }]] })
  })

  afterEach(() => {
    listActive.mockReset()
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    await app.close()
  })

  it('omite y registra con nivel error al pagador que no cumple publicPayerSchema, sin tumbar a los demás', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const broken: Payer = {
      ...sea,
      id: '01890a5d-ac96-774b-bcce-b302099a8058',
      slug: 'rota',
      advancePercent: 0.5,
    }
    listActive.mockResolvedValueOnce([broken, sea])

    const res = await request(app.getHttpServer()).get(PAYERS_PATH).expect(200)

    expect(payersEnvelopeSchema.safeParse(res.body).success).toBe(true)
    expect(res.body.data.map((payer: { slug: string }) => payer.slug)).toEqual(['sea'])
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ payerId: broken.id, slug: 'rota' }),
      'Pagador omitido de la lista pública: no cumple publicPayerSchema',
    )
  })

  it('un error inesperado del repositorio (un defecto) responde 500 INTERNAL_ERROR en el sobre y sin caché pública', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    listActive.mockRejectedValueOnce(new Error('defecto del repositorio'))

    const res = await request(app.getHttpServer()).get(PAYERS_PATH).expect(500)

    expect(apiErrorEnvelopeSchema.safeParse(res.body).success).toBe(true)
    expect(res.body.code).toBe('INTERNAL_ERROR')
    expect(JSON.stringify(res.body)).not.toContain('defecto del repositorio')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers[CORRELATION_ID_HEADER]).toBe(res.body.correlationId)
  })

  it('si hay activos y ninguno cumple publicPayerSchema, responde 500 INTERNAL_ERROR sin caché (nunca una lista vacía cacheable)', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const broken: Payer = { ...sea, advancePercent: 0.5 }
    const alsoBroken: Payer = {
      ...sea,
      id: '01890a5d-ac96-774b-bcce-b302099a8058',
      slug: 'rota',
      accentColor: 'rojo',
    }
    listActive.mockResolvedValueOnce([broken, alsoBroken])

    const res = await request(app.getHttpServer()).get(PAYERS_PATH).expect(500)

    expect(apiErrorEnvelopeSchema.safeParse(res.body).success).toBe(true)
    expect(res.body.code).toBe('INTERNAL_ERROR')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ payerId: alsoBroken.id, slug: 'rota' }),
      'Pagador omitido de la lista pública: no cumple publicPayerSchema',
    )
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INTERNAL_ERROR', statusCode: 500 }),
      'Respuesta 500 INTERNAL_ERROR',
    )
  })

  it('sin activos (el repositorio no devuelve ninguno) sigue siendo 200 con la lista vacía y caché pública', async () => {
    listActive.mockResolvedValueOnce([])
    const res = await request(app.getHttpServer()).get(PAYERS_PATH).expect(200)
    expect(res.body.data).toEqual([])
    expect(res.headers['cache-control']).toBe(PUBLIC_PAYERS_CACHE_CONTROL)
  })
})

describe('topes de subida contra el máximo de facturas de cada pagador activo', () => {
  const db = createTestPrisma()

  beforeEach(async () => {
    await truncateAll(db.prisma)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    await db.close()
  })

  /** Contextos de los logs de error de los topes (los que nombran una variable de subida). */
  const capacityErrors = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls
      .map(([context]) => context)
      .filter(
        (context): context is Record<string, unknown> =>
          typeof context === 'object' && context !== null && 'variable' in context,
      )

  it('al arrancar, un pagador con más facturas de las que admite UPLOAD_MAX_FILES deja un error con la variable a subir', async () => {
    const payer = await createPayer(db.prisma, { maxInvoices: 15 })
    await createPayer(db.prisma, { ...AGRO_ANDINA, allowedCurrencies: ['PEN'] })
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)

    const app = await createTestApp({ env: { UPLOAD_MAX_FILES: '20' } })
    // La revisión del arranque no frena el arranque; el cierre la espera.
    await app.close()

    expect(capacityErrors(error)).toEqual([
      {
        payerId: payer.id,
        slug: SEA.slug,
        maxInvoices: 15,
        variable: 'UPLOAD_MAX_FILES',
        current: 20,
        required: 30,
      },
    ])
  })

  it('al servir los pagadores, un máximo cambiado en la base sin desplegar deja el error una sola vez y la lista sale igual', async () => {
    const payer = await createPayer(db.prisma)
    const app = await createTestApp({ env: { UPLOAD_MAX_FILES: '20' } })
    try {
      const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
      await request(app.getHttpServer()).get(PAYERS_PATH).expect(200)
      expect(capacityErrors(error)).toEqual([])

      await db.prisma.payer.update({ where: { id: payer.id }, data: { maxInvoices: 12 } })
      for (let n = 0; n < 2; n += 1) {
        const res = await request(app.getHttpServer()).get(PAYERS_PATH).expect(200)
        expect(res.body.data.map((p: { maxInvoices: number }) => p.maxInvoices)).toEqual([12])
      }
      expect(capacityErrors(error)).toEqual([
        {
          payerId: payer.id,
          slug: SEA.slug,
          maxInvoices: 12,
          variable: 'UPLOAD_MAX_FILES',
          current: 20,
          required: 24,
        },
      ])
    } finally {
      await app.close()
    }
  })
})

describe('GET /api/v1/payers con la base caída', () => {
  const UNREACHABLE_DATABASE_URL = 'postgresql://anticipate:anticipate@127.0.0.1:1/anticipate_test'
  let app: NestExpressApplication

  beforeAll(async () => {
    app = await createTestApp({
      env: {
        DATABASE_URL: UNREACHABLE_DATABASE_URL,
        DATABASE_DIRECT_URL: UNREACHABLE_DATABASE_URL,
      },
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    await app.close()
  })

  it('responde 503 SERVICE_UNAVAILABLE (no 500) en el sobre, sin caché pública ni el host', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const res = await request(app.getHttpServer()).get(PAYERS_PATH).expect(503)

    expect(apiErrorEnvelopeSchema.safeParse(res.body).success).toBe(true)
    expect(res.body.code).toBe('SERVICE_UNAVAILABLE')
    expect(JSON.stringify(res.body)).not.toMatch(/127\.0\.0\.1|P1001|reach|database server/i)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers[CORRELATION_ID_HEADER]).toBe(res.body.correlationId)
  })
})
