import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { advanceRequestCreatedSchema } from '@anticipate/shared/advance-request'
import {
  type ApiErrorCode,
  type ApiErrorEnvelope,
  apiErrorEnvelopeSchema,
  apiSuccessEnvelopeSchema,
} from '@anticipate/shared/api'
import type { Problem } from '@anticipate/shared/errors'
import type { NestExpressApplication } from '@nestjs/platform-express'
import type { Response } from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CAPTCHA_VERIFIER } from '#/common/captcha/index.js'
import {
  CORRELATION_ID_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
} from '#/common/constants/http-headers.constants.js'
import { FakeEmailSender } from '#/infrastructure/notifications/index.js'
import { PrismaService } from '#/infrastructure/prisma/index.js'
import { PrismaAdvanceRequestRepository } from '#/infrastructure/prisma/repositories/advance-requests/prisma-advance-request.repository.js'
import { PrismaPayerConditionsReader } from '#/infrastructure/prisma/repositories/advance-requests/prisma-payer-conditions.reader.js'
import {
  ADVANCE_REQUEST_REPOSITORY,
  PAYER_CONDITIONS_READER,
  type PayerConditions,
  type PayerConditionsReaderPort,
} from '#/modules/advance-requests/index.js'
import { EMAIL_SENDER } from '#/modules/notifications/index.js'
import { PublishOutboxEventsUseCase } from '#/modules/outbox/index.js'
import {
  ADVANCE_REQUESTS_PATH,
  ensureLegalDocumentVersions,
  FIXTURE_LEGAL_VERSIONS,
  invoiceXml,
  newIdempotencyKey,
  pdf,
  type SubmitOptions,
  submitAdvanceRequest,
  validForm,
} from '../support/advance-request-fixtures.js'
import { createTestApp } from '../support/app.js'
import { testConfig } from '../support/config.js'
import { createTestPrisma, truncateAll } from '../support/db.js'
import { createPayer } from '../support/factories.js'
import { FakeCaptchaVerifier } from '../support/fakes.js'
import { deletePrefix, listKeys } from '../support/s3.js'

const captcha = new FakeCaptchaVerifier()
const mailer = new FakeEmailSender()
const db = createTestPrisma()
const config = testConfig()
const overrides = [
  [CAPTCHA_VERIFIER, captcha],
  [EMAIL_SENDER, mailer],
] as const
const createdEnvelopeSchema = apiSuccessEnvelopeSchema(advanceRequestCreatedSchema)

let app: NestExpressApplication
let payerId: string

const submit = (options: SubmitOptions = {}) => submitAdvanceRequest(app, options)
const payerPrefix = () => `payers/${payerId}/`

/** 201 con el sobre de éxito; la cabecera de correlación es la del cuerpo. */
function expectCreated(res: Response): { publicCode: string; correlationId: string } {
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  const body = createdEnvelopeSchema.parse(res.body)
  expect(body.message).toBe('Solicitud recibida.')
  expect(res.headers[CORRELATION_ID_HEADER]).toBe(body.correlationId)
  return { publicCode: body.data.publicCode, correlationId: body.correlationId }
}

/** Error con el sobre de error de shared, su código y la misma correlación en cabecera y cuerpo. */
function expectError(res: Response, status: number, code: ApiErrorCode): ApiErrorEnvelope {
  expect(res.status, JSON.stringify(res.body)).toBe(status)
  const body = apiErrorEnvelopeSchema.parse(res.body)
  expect(body.code).toBe(code)
  expect(res.headers[CORRELATION_ID_HEADER]).toBe(body.correlationId)
  return body
}

/**
 * El repositorio real, salvo que `create` lanza después de confirmar: la transacción quedó guardada
 * pero la API no se entera (se cortó la conexión después del COMMIT).
 */
class CommitAckLostRepository extends PrismaAdvanceRequestRepository {
  override async create(
    ...args: Parameters<PrismaAdvanceRequestRepository['create']>
  ): ReturnType<PrismaAdvanceRequestRepository['create']> {
    const result = await super.create(...args)
    if (result.kind === 'created') throw new Error('se cortó la conexión después del COMMIT')
    return result
  }
}

/**
 * El lector real de las condiciones del pagador, salvo que la primera lectura espera a `resume()`.
 * Deja a ese envío detenido entre la búsqueda de su clave (paso 2) y la de sus facturas (paso 6).
 */
class PausedFirstPayerRead implements PayerConditionsReaderPort {
  readonly paused: Promise<void>
  private markPaused: () => void = () => undefined
  private readonly resumed: Promise<void>
  private markResumed: () => void = () => undefined
  private reads = 0

  constructor(private readonly reader: PayerConditionsReaderPort) {
    this.paused = new Promise((resolve) => {
      this.markPaused = resolve
    })
    this.resumed = new Promise((resolve) => {
      this.markResumed = resolve
    })
  }

  resume(): void {
    this.markResumed()
  }

  async findActiveBySlug(slug: string): Promise<PayerConditions | null> {
    this.reads += 1
    if (this.reads === 1) {
      this.markPaused()
      await this.resumed
    }
    return this.reader.findActiveBySlug(slug)
  }
}

const problemsOf = (body: ApiErrorEnvelope): Problem[] =>
  body.details !== undefined && 'problems' in body.details ? body.details.problems : []

const violationFields = (body: ApiErrorEnvelope): string[] =>
  body.details !== undefined && 'violations' in body.details
    ? body.details.violations.map(({ field }) => field)
    : []

async function withApp(
  env: Record<string, string>,
  run: (other: NestExpressApplication) => Promise<void>,
  extraOverrides: ReadonlyArray<readonly [token: unknown, value: unknown]> = [],
) {
  const other = await createTestApp({ env, overrides: [...overrides, ...extraOverrides] })
  try {
    await run(other)
  } finally {
    await other.close()
  }
}

beforeAll(async () => {
  app = await createTestApp({ overrides })
})

beforeEach(async () => {
  await truncateAll(db.prisma)
  await ensureLegalDocumentVersions(db.prisma)
  payerId = (await createPayer(db.prisma)).id
  captcha.reset()
  mailer.reset()
})

// Cada test sube bajo el prefijo de su pagador (nuevo en cada test): lo deja vacío al terminar.
afterEach(async () => {
  await deletePrefix(payerPrefix())
})

afterAll(async () => {
  await app.close()
  await db.close()
})

describe('POST /api/v1/advance-requests · camino feliz', () => {
  it('guarda todo, sube los archivos, deja dos filas en el outbox y publica dos correos', async () => {
    const res = await submit({
      correlationId: 'prueba-correlacion-001',
      xml: [
        [
          invoiceXml({
            installments: [
              { id: 'Cuota001', amount: '5310.00', dueDate: '2026-10-30' },
              { id: 'Cuota002', amount: '5310.00', dueDate: '2026-11-30' },
            ],
          }),
          'F001-123.xml',
        ],
      ],
      pdf: [[pdf(), 'F001-123.pdf']],
    })
    const { publicCode, correlationId } = expectCreated(res)
    expect(publicCode).toMatch(/^ANT-2026-\d{6}$/)
    expect(correlationId).toBe('prueba-correlacion-001')

    const saved = await db.prisma.advanceRequest.findUniqueOrThrow({
      where: { publicCode },
      include: {
        invoices: { include: { installments: { orderBy: { number: 'asc' } } } },
        consents: true,
        statusHistory: true,
        outboxEvents: { orderBy: { handler: 'asc' } },
        supplier: { include: { legalRepresentatives: true } },
      },
    })
    expect(saved).toMatchObject({
      status: 'NEW',
      version: 1,
      currency: 'PEN',
      payerId,
      payerRuc: '20131312955',
      supplierRuc: '20100070970',
      supplierLegalName: 'PROVEEDOR EJEMPLO S.A.C.',
      contactEmail: 'ana@proveedor.pe',
      correlationId: 'prueba-correlacion-001',
      appliedMinTermDays: 15,
      invoiceCount: 1,
      purpose: 'Capital de trabajo',
    })
    // Foto del pagador y de los montos al crear.
    expect(saved.appliedAdvancePercent.toFixed(2)).toBe('80.00')
    expect(saved.totalNetPending.toFixed(2)).toBe('10620.00')
    expect(saved.maxAmount.toFixed(2)).toBe('8496.00')
    expect(saved.requestedAmount.toFixed(2)).toBe('8000.00')
    expect(saved.earliestDueDate.toISOString().slice(0, 10)).toBe('2026-10-30')
    expect(saved.legalRepresentativeId).toBe(saved.supplier.legalRepresentatives[0]?.id)

    const [invoice] = saved.invoices
    expect(invoice).toMatchObject({
      invoiceKey: '20100070970|F001-123',
      requestStatus: 'NEW',
      paymentTerms: 'CREDIT',
      issuerRuc: '20100070970',
      recipientRuc: '20131312955',
    })
    expect(invoice?.dueDate.toISOString().slice(0, 10)).toBe('2026-11-30')
    expect(
      invoice?.installments.map((i) => [
        i.number,
        i.label,
        i.amount.toFixed(2),
        i.dueDate.toISOString().slice(0, 10),
      ]),
    ).toEqual([
      [1, 'Cuota001', '5310.00', '2026-10-30'],
      [2, 'Cuota002', '5310.00', '2026-11-30'],
    ])
    expect(saved.consents.map((c) => [c.type, c.documentVersion]).sort()).toEqual([
      ['PERSONAL_DATA', FIXTURE_LEGAL_VERSIONS.privacy],
      ['TERMS', FIXTURE_LEGAL_VERSIONS.terms],
    ])
    expect(
      saved.statusHistory.map((h) => [h.fromStatus, h.toStatus, h.version, h.correlationId]),
    ).toEqual([[null, 'NEW', 1, 'prueba-correlacion-001']])

    const files = await db.prisma.storedFile.findMany({ orderBy: { purpose: 'asc' } })
    expect(files.map((f) => [f.purpose, f.status, f.storageBucket])).toEqual([
      ['INVOICE_XML', 'ATTACHED', config.storage.bucket],
      ['INVOICE_PDF', 'ATTACHED', config.storage.bucket],
    ])
    expect(files.every((f) => f.attachedAt !== null)).toBe(true)
    expect([invoice?.xmlFileId, invoice?.pdfFileId].sort()).toEqual(files.map((f) => f.id).sort())
    const keys = await listKeys(payerPrefix())
    expect(keys).toEqual(files.map((f) => f.key).sort())
    expect(
      keys.every((k) => k.startsWith(`${payerPrefix()}advance-requests/${saved.id}/invoices/`)),
    ).toBe(true)

    expect(saved.outboxEvents.map((e) => [e.handler, e.status, e.correlationId])).toEqual([
      ['email.supplier-confirmation', 'PENDING', 'prueba-correlacion-001'],
      ['email.team-alert', 'PENDING', 'prueba-correlacion-001'],
    ])
    for (const event of saved.outboxEvents) {
      expect(event.payload).toMatchObject({
        type: 'advance-request.created',
        version: 1,
        aggregateId: saved.id,
      })
      const serialized = JSON.stringify(event.payload)
      expect(serialized).not.toContain('ana@proveedor.pe')
      expect(serialized).not.toContain('20100070970')
    }

    await expect(app.get(PublishOutboxEventsUseCase).execute()).resolves.toEqual({
      published: 2,
      retried: 0,
      deadLettered: 0,
      leaseLost: 0,
    })
    const published = await db.prisma.outboxEvent.findMany({
      where: { advanceRequestId: saved.id },
    })
    expect(published.map((e) => e.status)).toEqual(['PUBLISHED', 'PUBLISHED'])
    expect(mailer.sent.map((m) => [m.subject, m.to.email]).sort()).toEqual([
      [`Nueva solicitud ${publicCode} · SEA`, config.teamNotificationEmail],
      [`Recibimos tu solicitud ${publicCode}`, 'ana@proveedor.pe'],
    ])
    expect(mailer.sent.map((m) => m.idempotencyKey).sort()).toEqual(
      saved.outboxEvents.map((e) => e.id).sort(),
    )
  })

  it('la foto del pagador no cambia si después cambian sus condiciones', async () => {
    const { publicCode } = expectCreated(await submit())
    await db.prisma.payer.update({ where: { id: payerId }, data: { advancePercent: '50.00' } })
    const saved = await db.prisma.advanceRequest.findUniqueOrThrow({ where: { publicCode } })
    expect(saved.appliedAdvancePercent.toFixed(2)).toBe('80.00')
  })

  it('una segunda solicitud del mismo proveedor reutiliza proveedor y representante', async () => {
    expectCreated(await submit())
    expectCreated(
      await submit({ xml: [[invoiceXml({ seriesNumber: 'F001-124' }), 'F001-124.xml']] }),
    )
    expect(await db.prisma.supplier.count()).toBe(1)
    expect(await db.prisma.legalRepresentative.count()).toBe(1)
    expect(await db.prisma.advanceRequest.count()).toBe(2)
  })
})

describe('POST /api/v1/advance-requests · idempotencia', () => {
  it('un reintento con la misma clave repite la respuesta sin guardar ni subir nada', async () => {
    const idempotencyKey = newIdempotencyKey()
    const first = expectCreated(await submit({ idempotencyKey, pdf: [[pdf(), 'F001-123.pdf']] }))
    const keysBefore = await listKeys(payerPrefix())
    const retry = await submit({ idempotencyKey, pdf: [[pdf(), 'F001-123.pdf']] })
    expect(expectCreated(retry).publicCode).toBe(first.publicCode)
    expect(retry.headers[IDEMPOTENT_REPLAYED_HEADER]).toBe('true')
    expect(await db.prisma.advanceRequest.count()).toBe(1)
    expect(await db.prisma.storedFile.count()).toBe(2)
    expect(await listKeys(payerPrefix())).toEqual(keysBefore)
  })

  it('el verificador del captcha recibe la clave del envío', async () => {
    const idempotencyKey = newIdempotencyKey()
    expectCreated(await submit({ idempotencyKey }))
    expect(captcha.lastIdempotencyKey).toBe(idempotencyKey)
  })

  it('la misma clave con otro formulario: 422 IDEMPOTENCY_KEY_REUSED', async () => {
    const idempotencyKey = newIdempotencyKey()
    expectCreated(await submit({ idempotencyKey }))
    const other = validForm({ financing: { requestedAmount: '7000.00' } })
    expectError(await submit({ idempotencyKey, form: other }), 422, 'IDEMPOTENCY_KEY_REUSED')
    expect(await db.prisma.advanceRequest.count()).toBe(1)
  })

  it('dos envíos simultáneos con la misma clave: el mismo código y un solo registro', async () => {
    const idempotencyKey = newIdempotencyKey()
    const [a, b] = await Promise.all([submit({ idempotencyKey }), submit({ idempotencyKey })])
    expect(expectCreated(a).publicCode).toBe(expectCreated(b).publicCode)
    expect(await db.prisma.advanceRequest.count()).toBe(1)
    const files = await db.prisma.storedFile.findMany()
    const attached = files.filter((f) => f.status === 'ATTACHED')
    expect(attached).toHaveLength(1)
    expect(files.filter((f) => f.status !== 'ATTACHED').every((f) => f.status === 'DELETED')).toBe(
      true,
    )
    expect(await listKeys(payerPrefix())).toEqual(attached.map((f) => f.key))
  })

  it('cinco reintentos simultáneos con la misma clave: el mismo código, un registro y solo sus archivos', async () => {
    const idempotencyKey = newIdempotencyKey()
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => submit({ idempotencyKey, pdf: [[pdf(), 'F001-123.pdf']] })),
    )
    expect(new Set(responses.map((res) => expectCreated(res).publicCode)).size).toBe(1)
    expect(await db.prisma.advanceRequest.count()).toBe(1)
    const files = await db.prisma.storedFile.findMany()
    const attached = files.filter((f) => f.status === 'ATTACHED')
    expect(attached).toHaveLength(2)
    expect(files.filter((f) => f.status !== 'ATTACHED').every((f) => f.status === 'DELETED')).toBe(
      true,
    )
    expect(await listKeys(payerPrefix())).toEqual(attached.map((f) => f.key).sort())
  })

  it('dos envíos simultáneos con la misma clave y otro contenido: 201 y 422 IDEMPOTENCY_KEY_REUSED', async () => {
    const idempotencyKey = newIdempotencyKey()
    const [a, b] = await Promise.all([
      submit({ idempotencyKey }),
      submit({
        idempotencyKey,
        xml: [[invoiceXml({ seriesNumber: 'F001-124' }), 'F001-124.xml']],
      }),
    ])
    expect([a.status, b.status].sort()).toEqual([201, 422])
    expectError(a.status === 422 ? a : b, 422, 'IDEMPOTENCY_KEY_REUSED')
    expect(await db.prisma.advanceRequest.count()).toBe(1)
    const attached = (await db.prisma.storedFile.findMany()).filter((f) => f.status === 'ATTACHED')
    expect(await listKeys(payerPrefix())).toEqual(attached.map((f) => f.key).sort())
  })

  describe('D45: el original confirma entre la búsqueda de la clave y la de las facturas', () => {
    /**
     * El reintento sale primero y se detiene después de buscar su clave (no está); el original guarda
     * todo; el reintento sigue y encuentra sus facturas tomadas por la solicitud de su propia clave.
     */
    async function retryAfterOriginalCommits(retryOptions: SubmitOptions) {
      const idempotencyKey = newIdempotencyKey()
      const gate = new PausedFirstPayerRead(new PrismaPayerConditionsReader(db.prisma))
      let original: Response | undefined
      let retry: Response | undefined
      await withApp(
        {},
        async (other) => {
          const pending = submitAdvanceRequest(other, { ...retryOptions, idempotencyKey }).then(
            (res) => res,
          )
          try {
            await gate.paused
            original = await submitAdvanceRequest(other, { idempotencyKey })
          } finally {
            gate.resume()
          }
          retry = await pending
        },
        [[PAYER_CONDITIONS_READER, gate]],
      )
      if (original === undefined || retry === undefined) throw new Error('faltan respuestas')
      return { original: expectCreated(original), retry }
    }

    it('con el mismo contenido: 201 repetido con el mismo código, nunca un falso 422', async () => {
      const { original, retry } = await retryAfterOriginalCommits({})
      expect(expectCreated(retry).publicCode).toBe(original.publicCode)
      expect(retry.headers[IDEMPOTENT_REPLAYED_HEADER]).toBe('true')
      expect(await db.prisma.advanceRequest.count()).toBe(1)
      // El reintento no reservó ni subió nada: solo queda el XML del original.
      const files = await db.prisma.storedFile.findMany()
      expect(files.map((f) => f.status)).toEqual(['ATTACHED'])
      expect(await listKeys(payerPrefix())).toEqual(files.map((f) => f.key))
    })

    it('con otro contenido: 422 IDEMPOTENCY_KEY_REUSED, no INVOICE_ALREADY_IN_OPEN_REQUEST', async () => {
      const { retry } = await retryAfterOriginalCommits({
        form: validForm({ financing: { requestedAmount: '7000.00' } }),
      })
      expectError(retry, 422, 'IDEMPOTENCY_KEY_REUSED')
      expect(await db.prisma.advanceRequest.count()).toBe(1)
      expect(await db.prisma.storedFile.count()).toBe(1)
    })
  })

  it('ocho envíos simultáneos de un RUC nuevo con facturas distintas: ocho 201 y un proveedor', async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        submit({ xml: [[invoiceXml({ seriesNumber: `F001-${200 + i}` }), `F001-${200 + i}.xml`]] }),
      ),
    )
    const codes = responses.map((res) => expectCreated(res).publicCode)
    expect(new Set(codes).size).toBe(8)
    expect(await db.prisma.supplier.count()).toBe(1)
    expect(await db.prisma.legalRepresentative.count()).toBe(1)
    expect(await db.prisma.advanceRequest.count()).toBe(8)
  })

  it('sin Idempotency-Key o con una que no es UUID: 400 IDEMPOTENCY_KEY_INVALID', async () => {
    expectError(await submit({ idempotencyKey: null }), 400, 'IDEMPOTENCY_KEY_INVALID')
    expectError(await submit({ idempotencyKey: 'no-es-uuid' }), 400, 'IDEMPOTENCY_KEY_INVALID')
    expect(await db.prisma.advanceRequest.count()).toBe(0)
  })
})

describe('POST /api/v1/advance-requests · captcha', () => {
  it('token rechazado: 403 CAPTCHA_FAILED y nada guardado', async () => {
    captcha.valid = false
    expectError(await submit(), 403, 'CAPTCHA_FAILED')
    expect(await db.prisma.advanceRequest.count()).toBe(0)
    expect(await listKeys(payerPrefix())).toEqual([])
  })

  it('sin token: 403 CAPTCHA_FAILED sin consultar al verificador', async () => {
    expectError(await submit({ token: null }), 403, 'CAPTCHA_FAILED')
    expect(captcha.calls).toBe(0)
  })

  it('verificador sin respuesta: 503 CAPTCHA_UNAVAILABLE', async () => {
    captcha.unavailable = true
    expectError(await submit(), 503, 'CAPTCHA_UNAVAILABLE')
    expect(await db.prisma.advanceRequest.count()).toBe(0)
  })
})

describe('POST /api/v1/advance-requests · forma y negocio', () => {
  it('un form que no es JSON: 400 VALIDATION_ERROR en form', async () => {
    const body = expectError(await submit({ form: '{no es json' }), 400, 'VALIDATION_ERROR')
    expect(violationFields(body)).toEqual(['form'])
  })

  it('un form inválido: 400 con la ruta de cada campo', async () => {
    const form = { ...validForm(), company: { ruc: '123', legalName: 'X' } }
    const body = expectError(await submit({ form }), 400, 'VALIDATION_ERROR')
    expect(violationFields(body)).toEqual(
      expect.arrayContaining(['company.ruc', 'company.legalName']),
    )
  })

  it('un pagador inexistente: 422 PAYER_NOT_AVAILABLE', async () => {
    const body = expectError(
      await submit({ form: validForm({ payerSlug: 'no-existe' }) }),
      422,
      'BUSINESS_RULES_VIOLATED',
    )
    expect(problemsOf(body)).toEqual([
      expect.objectContaining({ code: 'PAYER_NOT_AVAILABLE', field: 'payerSlug' }),
    ])
  })

  it('una versión legal retirada: 422 CONSENT_VERSION_OUTDATED en su campo', async () => {
    await db.prisma.legalDocumentVersion.update({
      where: { type_version: { type: 'TERMS', version: FIXTURE_LEGAL_VERSIONS.terms } },
      data: { retiredAt: new Date('2026-09-20T00:00:00.000Z') },
    })
    const body = expectError(await submit(), 422, 'BUSINESS_RULES_VIOLATED')
    expect(problemsOf(body)).toEqual([
      expect.objectContaining({ code: 'CONSENT_VERSION_OUTDATED', field: 'consents.termsVersion' }),
    ])
  })

  it('una versión legal que no existe: 422 en consents.privacyVersion', async () => {
    const form = validForm()
    const body = expectError(
      await submit({
        form: { ...form, consents: { ...form.consents, privacyVersion: '1999-01' } },
      }),
      422,
      'BUSINESS_RULES_VIOLATED',
    )
    expect(problemsOf(body).map((p) => [p.code, p.field])).toEqual([
      ['CONSENT_VERSION_OUTDATED', 'consents.privacyVersion'],
    ])
  })

  it('una factura con emisión futura: 422 ISSUE_DATE_IN_FUTURE, nunca 503 por un CHECK', async () => {
    const res = await submit({
      xml: [[invoiceXml({ issueDate: '2026-09-25' }), 'F001-123.xml']],
    })
    const body = expectError(res, 422, 'BUSINESS_RULES_VIOLATED')
    expect(problemsOf(body).map((p) => p.code)).toEqual(['ISSUE_DATE_IN_FUTURE'])
    expect(await db.prisma.storedFile.count()).toBe(0)
  })

  it('junta los problemas de todas las facturas y archivos en una sola respuesta', async () => {
    const res = await submit({
      xml: [
        [invoiceXml({ seriesNumber: 'F001-1', recipientRuc: '20100070970' }), 'F001-1.xml'],
        [Buffer.from('%PDF-1.7 no soy xml'), 'F001-2.xml'],
      ],
      pdf: [
        [Buffer.from('tampoco soy pdf'), 'F001-1.pdf'],
        [pdf(), 'F001-9.pdf'],
      ],
    })
    const problems = problemsOf(expectError(res, 422, 'BUSINESS_RULES_VIOLATED'))
    expect(problems.map((p) => p.code).sort()).toEqual([
      'INVALID_PDF',
      'PDF_WITHOUT_XML',
      'RECIPIENT_IS_NOT_PAYER',
      'UNREADABLE_XML',
    ])
    expect(problems.find((p) => p.code === 'PDF_WITHOUT_XML')?.file).toBe('F001-9.pdf')
    expect(problems.find((p) => p.code === 'UNREADABLE_XML')?.file).toBe('F001-2.xml')
    expect(await listKeys(payerPrefix())).toEqual([])
  })

  it('un monto mayor al máximo: 422 AMOUNT_EXCEEDS_MAXIMUM', async () => {
    const body = expectError(
      await submit({ form: validForm({ financing: { requestedAmount: '9000.00' } }) }),
      422,
      'BUSINESS_RULES_VIOLATED',
    )
    expect(problemsOf(body)).toEqual([
      expect.objectContaining({ code: 'AMOUNT_EXCEEDS_MAXIMUM', field: 'requestedAmount' }),
    ])
  })
})

describe('POST /api/v1/advance-requests · facturas tomadas y fallas', () => {
  it('una factura que ya está en una solicitud abierta: 422 sin subir archivos', async () => {
    expectCreated(await submit())
    const keysBefore = await listKeys(payerPrefix())
    const body = expectError(await submit(), 422, 'BUSINESS_RULES_VIOLATED')
    expect(problemsOf(body)).toEqual([
      expect.objectContaining({
        code: 'INVOICE_ALREADY_IN_OPEN_REQUEST',
        invoice: 'F001-123',
        file: 'F001-123.xml',
      }),
    ])
    expect(await listKeys(payerPrefix())).toEqual(keysBefore)
  })

  it('dos envíos simultáneos con la misma factura: uno gana y el otro no deja archivos', async () => {
    const [a, b] = await Promise.all([submit(), submit()])
    expect([a.status, b.status].sort()).toEqual([201, 422])
    const loser = a.status === 422 ? a : b
    expect(
      problemsOf(expectError(loser, 422, 'BUSINESS_RULES_VIOLATED')).map((p) => p.code),
    ).toEqual(['INVOICE_ALREADY_IN_OPEN_REQUEST'])
    const [saved] = await db.prisma.advanceRequest.findMany()
    const keys = await listKeys(payerPrefix())
    expect(keys.every((k) => k.includes(`/advance-requests/${saved?.id}/`))).toBe(true)
  })

  it('si la transacción falla: 503, objetos borrados y filas DELETED', async () => {
    await db.prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_fail_consents() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'falla simulada'; END $$`)
    await db.prisma.$executeRawUnsafe(`
      CREATE TRIGGER test_fail_consents BEFORE INSERT ON consents
      FOR EACH ROW EXECUTE FUNCTION test_fail_consents()`)
    try {
      expectError(await submit({ pdf: [[pdf(), 'F001-123.pdf']] }), 503, 'SERVICE_UNAVAILABLE')
      expect(await db.prisma.advanceRequest.count()).toBe(0)
      const files = await db.prisma.storedFile.findMany()
      expect(files).toHaveLength(2)
      expect(files.every((f) => f.status === 'DELETED' && f.purgeAfter !== null)).toBe(true)
      expect(await listKeys(payerPrefix())).toEqual([])
    } finally {
      await db.prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_fail_consents ON consents')
      await db.prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_fail_consents()')
    }
  })

  it('COMMIT ambiguo: 503, la solicitud guardada conserva sus archivos y el reintento la devuelve', async () => {
    const idempotencyKey = newIdempotencyKey()
    const lossy = new CommitAckLostRepository(db.prisma, {
      transactionTimeoutMs: config.database.transactionTimeoutMs,
      transactionMaxWaitMs: config.database.transactionMaxWaitMs,
      outboxMaxAttempts: config.outbox.maxAttempts,
    })
    await withApp(
      {},
      async (other) => {
        const res = await submitAdvanceRequest(other, {
          idempotencyKey,
          pdf: [[pdf(), 'F001-123.pdf']],
        })
        expectError(res, 503, 'SERVICE_UNAVAILABLE')
      },
      [[ADVANCE_REQUEST_REPOSITORY, lossy]],
    )
    const saved = await db.prisma.advanceRequest.findFirstOrThrow()
    const files = await db.prisma.storedFile.findMany()
    expect(files.map((f) => f.status)).toEqual(['ATTACHED', 'ATTACHED'])
    expect(await listKeys(payerPrefix())).toEqual(files.map((f) => f.key).sort())

    const retry = await submit({ idempotencyKey, pdf: [[pdf(), 'F001-123.pdf']] })
    expect(expectCreated(retry).publicCode).toBe(saved.publicCode)
    expect(retry.headers[IDEMPOTENT_REPLAYED_HEADER]).toBe('true')
  })

  it('dos envíos simultáneos con las mismas facturas en otro orden: 201 y 422, nunca un bloqueo mutuo', async () => {
    // Proveedor y representante ya guardados: si fueran nuevos, el segundo envío esperaría al
    // primero al insertarlos y las facturas nunca se cruzarían.
    expectCreated(await submit({ xml: [[invoiceXml({ seriesNumber: 'F001-9' }), 'F001-9.xml']] }))
    // Cada factura tarda en insertarse: sin un orden común, cada envío toma una clave y espera la
    // que tomó el otro, y PostgreSQL aborta a uno por deadlock (503 en vez de 422).
    await db.prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_slow_invoices() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(0.5); RETURN NEW; END $$`)
    await db.prisma.$executeRawUnsafe(`
      CREATE TRIGGER test_slow_invoices BEFORE INSERT ON invoices
      FOR EACH ROW EXECUTE FUNCTION test_slow_invoices()`)
    try {
      const x = [invoiceXml({ seriesNumber: 'F001-1' }), 'F001-1.xml'] as const
      const y = [invoiceXml({ seriesNumber: 'F001-2' }), 'F001-2.xml'] as const
      const [a, b] = await Promise.all([submit({ xml: [x, y] }), submit({ xml: [y, x] })])
      expect([a.status, b.status].sort(), JSON.stringify([a.body, b.body])).toEqual([201, 422])
      const loser = a.status === 422 ? a : b
      expect(
        problemsOf(expectError(loser, 422, 'BUSINESS_RULES_VIOLATED')).map((p) => [p.code, p.file]),
      ).toEqual(
        expect.arrayContaining([
          ['INVOICE_ALREADY_IN_OPEN_REQUEST', 'F001-1.xml'],
          ['INVOICE_ALREADY_IN_OPEN_REQUEST', 'F001-2.xml'],
        ]),
      )
      // El primero (F001-9) y el ganador: tres XML guardados; lo del perdedor, liberado y borrado.
      const files = await db.prisma.storedFile.findMany()
      const attached = files.filter((f) => f.status === 'ATTACHED')
      expect(attached).toHaveLength(3)
      expect(await listKeys(payerPrefix())).toEqual(attached.map((f) => f.key).sort())
    } finally {
      await db.prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_slow_invoices ON invoices')
      await db.prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_slow_invoices()')
    }
  })

  it('con la base inalcanzable: 503 SERVICE_UNAVAILABLE (nunca 500), sin subir nada ni revelar el host', async () => {
    const unreachable = 'postgresql://anticipate:anticipate@127.0.0.1:1/anticipate_test'
    await withApp(
      { DATABASE_URL: unreachable, DATABASE_DIRECT_URL: unreachable },
      async (other) => {
        const res = await submitAdvanceRequest(other, { pdf: [[pdf(), 'F001-123.pdf']] })
        const body = expectError(res, 503, 'SERVICE_UNAVAILABLE')
        expect(JSON.stringify(body)).not.toMatch(/127\.0\.0\.1|P1001|reach|database server/i)
      },
    )
    expect(await listKeys(payerPrefix())).toEqual([])
  })

  it('con el pool sin conexiones libres: 503 SERVICE_UNAVAILABLE a tiempo, nunca 500', async () => {
    await withApp(
      { DATABASE_POOL_MAX: '1', DATABASE_CONNECTION_TIMEOUT_MS: '300' },
      async (other) => {
        // Otra operación ocupa la única conexión: la lectura de la clave no consigue una y pg-pool
        // lanza su propio Error ('timeout exceeded when trying to connect'), sin código de Prisma.
        const prisma = other.get(PrismaService)
        let markHeld: () => void = () => undefined
        const held = new Promise<void>((resolve) => {
          markHeld = resolve
        })
        const holding = prisma.$transaction(async (tx) => {
          markHeld()
          await tx.$queryRaw`SELECT pg_sleep(1.5)::text`
        })
        await held
        try {
          expectError(await submitAdvanceRequest(other), 503, 'SERVICE_UNAVAILABLE')
        } finally {
          await holding
        }
      },
    )
    expect(await db.prisma.advanceRequest.count()).toBe(0)
    expect(await listKeys(payerPrefix())).toEqual([])
  })

  it('una IP ilegible en X-Forwarded-For (detrás de un proxy de confianza) no impide guardar', async () => {
    // Los tests llegan desde 127.0.0.1 y TRUST_PROXY=loopback confía en él: Express toma de
    // X-Forwarded-For lo que venga. consents.ip es inet y no guardaría ese texto.
    const { publicCode } = expectCreated(await submit().set('X-Forwarded-For', 'no-es-una-ip'))
    const saved = await db.prisma.advanceRequest.findUniqueOrThrow({
      where: { publicCode },
      include: { consents: true },
    })
    expect(saved.consents.map((c) => c.ip)).toEqual(['0.0.0.0', '0.0.0.0'])
  })
})

describe('POST /api/v1/advance-requests · límites', () => {
  it('un XML o un PDF mayor a su tope: 422 con el nombre de cada archivo', async () => {
    await withApp({ UPLOAD_MAX_XML_BYTES: '1000', UPLOAD_MAX_PDF_BYTES: '20' }, async (small) => {
      const res = await submitAdvanceRequest(small, { pdf: [[pdf(), 'F001-123.pdf']] })
      const problems = problemsOf(expectError(res, 422, 'BUSINESS_RULES_VIOLATED'))
      expect(problems.map((p) => [p.code, p.file])).toEqual([
        ['XML_TOO_LARGE', 'F001-123.xml'],
        ['FILE_TOO_LARGE', 'F001-123.pdf'],
      ])
      expect(await listKeys(payerPrefix())).toEqual([])
    })
  })

  it('un cuerpo mayor al máximo: 413 antes de leerlo, sin consultar el captcha', async () => {
    await withApp({ UPLOAD_MAX_BODY_BYTES: '5000' }, async (small) => {
      const res = await submitAdvanceRequest(small, {
        pdf: [[Buffer.alloc(20_000, 0x20), 'grande.pdf']],
      })
      expectError(res, 413, 'PAYLOAD_TOO_LARGE')
      expect(captcha.calls).toBe(0)
    })
  })

  it('un envío sin Content-Length (chunked): 411 sin consultar el captcha', async () => {
    const server = app.getHttpServer()
    if (!server.listening)
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const { status, body } = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: ADVANCE_REQUESTS_PATH,
            headers: {
              'content-type': 'multipart/form-data; boundary=x',
              'transfer-encoding': 'chunked',
              'x-turnstile-token': 't',
              'idempotency-key': newIdempotencyKey(),
            },
          },
          (res) => {
            let text = ''
            res.setEncoding('utf8')
            res.on('data', (chunk: string) => {
              text += chunk
            })
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
          },
        )
        req.on('error', reject)
        req.end('--x--')
      },
    )
    expect(status).toBe(411)
    expect(apiErrorEnvelopeSchema.parse(JSON.parse(body)).code).toBe('LENGTH_REQUIRED')
    expect(captcha.calls).toBe(0)
  })

  it('más archivos que el máximo: 400 TOO_MANY_FILES', async () => {
    await withApp({ UPLOAD_MAX_FILES: '2' }, async (small) => {
      const res = await submitAdvanceRequest(small, {
        xml: [1, 2, 3].map(
          (n) => [invoiceXml({ seriesNumber: `F001-${n}` }), `F001-${n}.xml`] as const,
        ),
      })
      expectError(res, 400, 'TOO_MANY_FILES')
    })
  })

  it('un archivo en un campo no permitido: 400 UNEXPECTED_FILE_FIELD', async () => {
    expectError(
      await submit({ otherFiles: [['adjunto', pdf(), 'otro.pdf']] }),
      400,
      'UNEXPECTED_FILE_FIELD',
    )
  })

  it('el límite de envíos por IP: 429 RATE_LIMIT_EXCEEDED', async () => {
    await withApp({ THROTTLE_SUBMIT_LIMIT: '1' }, async (limited) => {
      const form = validForm({ payerSlug: 'no-existe' })
      expectError(await submitAdvanceRequest(limited, { form }), 422, 'BUSINESS_RULES_VIOLATED')
      expectError(await submitAdvanceRequest(limited, { form }), 429, 'RATE_LIMIT_EXCEEDED')
    })
  })
})
