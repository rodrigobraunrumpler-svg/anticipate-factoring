import { createHash } from 'node:crypto'
import {
  type AdvanceRequestForm,
  advanceRequestFormSchema,
} from '@anticipate/shared/advance-request'
import { buildInvoiceXml, type TestXmlOptions } from '@anticipate/shared/testing'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  BusinessRulesViolatedError,
  isApplicationError,
  ServiceUnavailableError,
} from '#/common/exceptions/index.js'
import type { FileStoragePort, PutFileInput, StoredObject } from '#/common/storage/index.js'
import type {
  AdvanceRequestRepositoryPort,
  CreateAdvanceRequestResult,
  ReservedFile,
} from '#/modules/advance-requests/application/ports/advance-request-repository.port.js'
import type { InvoiceXmlParserPort } from '#/modules/advance-requests/application/ports/invoice-xml-parser.port.js'
import { InvoiceIntakeService } from '#/modules/advance-requests/application/services/invoice-intake.service.js'
import type { CreateAdvanceRequestInput } from '#/modules/advance-requests/application/types/create-advance-request.types.js'
import { IdempotencyKeyReusedError } from '#/modules/advance-requests/domain/exceptions/idempotency-key-reused.error.js'
import {
  SUBMISSION_RETRY_AFTER_SECONDS,
  SubmissionDeadlineExceededError,
} from '#/modules/advance-requests/domain/exceptions/submission-deadline-exceeded.error.js'
import type { UploadedFile } from '#/modules/advance-requests/domain/types/invoice-intake.types.js'
import type { NewAdvanceRequest } from '#/modules/advance-requests/domain/types/new-advance-request.js'
import type { PayerConditions } from '#/modules/advance-requests/domain/types/payer-conditions.js'
import type { NewOutboxMessage } from '#/modules/outbox/index.js'
import { InlineInvoiceXmlParser } from '../../../../../test/support/fakes.js'
import {
  type CreateAdvanceRequestDependencies,
  CreateAdvanceRequestUseCase,
  MAX_CREATE_ATTEMPTS,
} from './create-advance-request.use-case.js'

const NOW = new Date('2026-09-24T15:00:00.000Z')
const KEY = '0192f3a0-7c1e-7d2a-9b3c-4d5e6f708192'
const SEA: PayerConditions = {
  payerId: '0192f3a0-0000-7000-8000-00000000aaaa',
  slug: 'sea',
  ruc: '20131312955',
  shortName: 'SEA',
  advancePercent: 80,
  minTermDays: 15,
  maxInvoices: 10,
  allowedCurrencies: ['PEN', 'USD'],
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const file = (originalname: string, content: string | Buffer): UploadedFile => {
  const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
  return { originalname, buffer, size: buffer.length }
}
const xml = (name = 'F001-123.xml', options: TestXmlOptions = {}) =>
  file(name, buildInvoiceXml(options))
const pdf = (name = 'F001-123.pdf') => file(name, '%PDF-1.7\n%%EOF\n')

const form = (overrides: Partial<AdvanceRequestForm> = {}): AdvanceRequestForm =>
  advanceRequestFormSchema.parse({
    payerSlug: 'sea',
    contact: {
      fullName: 'Ana Pérez',
      dni: '46728673',
      mobile: '987654321',
      email: 'ana@proveedor.pe',
      isLegalRepresentative: true,
      contactTimeSlot: 'MORNING',
    },
    company: { ruc: '20100070970', legalName: 'PROVEEDOR EJEMPLO S.A.C.' },
    financing: { requestedAmount: '8000.00', purpose: '' },
    cavaliRegistration: 'UNKNOWN',
    consents: {
      terms: true,
      personalData: true,
      termsVersion: '2026-09',
      privacyVersion: '2026-09',
    },
    ...overrides,
  })

const input = (overrides: Partial<CreateAdvanceRequestInput> = {}): CreateAdvanceRequestInput => ({
  form: form(),
  xmlFiles: [xml()],
  pdfFiles: [pdf()],
  idempotencyKey: KEY,
  clientIp: '203.0.113.7',
  userAgent: 'Mozilla/5.0',
  correlationId: 'prueba-001',
  ...overrides,
})

/** Registro compartido de llamadas, para comprobar el orden de los pasos. */
let calls: string[]
/** La señal que recibió cada llamada, con el nombre de la dependencia. */
let signals: [call: string, signal: AbortSignal | undefined][]

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Como una dependencia bien hecha: no responde hasta que se cancela la señal, y rechaza con su motivo. */
function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal === undefined) return
    if (signal.aborted) reject(signal.reason)
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

class FakeRepository implements AdvanceRequestRepositoryPort {
  existing: { publicCode: string; requestFingerprint: string } | null = null
  openKeys: string[] = []
  /** Claves que otro envío deja tomadas cuando `create` responde `invoice-conflict`. */
  openKeysAfterConflict: string[] = []
  results: Array<CreateAdvanceRequestResult | Error> = []
  reserved: ReservedFile[] = []
  released: string[] = []
  /** Archivos que una transacción confirmada dejó `ATTACHED`: ya no se pueden liberar. */
  attached = new Set<string>()
  created: { request: NewAdvanceRequest; outbox: readonly NewOutboxMessage[] }[] = []
  /** Lo que devuelve `findByIdempotencyKey` después de un choque de clave. */
  winner: { publicCode: string; requestFingerprint: string } | null = null
  /** COMMIT ambiguo: la transacción confirma y aun así `create` lanza (se cortó la conexión). */
  loseCommitAck = false
  releaseError: Error | null = null
  /** `reserveFiles` tarda esto sin mirar la señal (la reserva no se corta). */
  reserveDelayMs = 0
  /** `create` no responde hasta que se cancela la señal y no confirma nada. */
  hangCreate = false
  /** COMMIT lento: `create` confirma (archivos ATTACHED) y responde recién a los ms, sin mirar la señal. */
  slowCommitAckMs = 0

  async findByIdempotencyKey(
    _key: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ publicCode: string; requestFingerprint: string } | null> {
    calls.push('findByIdempotencyKey')
    signals.push(['findByIdempotencyKey', options.signal])
    const found = this.existing
    this.existing = this.winner ?? this.existing
    return found
  }
  async findInvoiceKeysInOpenRequests(
    keys: readonly string[],
    options: { signal?: AbortSignal } = {},
  ): Promise<string[]> {
    calls.push('findInvoiceKeysInOpenRequests')
    signals.push(['findInvoiceKeysInOpenRequests', options.signal])
    return keys.filter((key) => this.openKeys.includes(key))
  }
  async reserveFiles(files: readonly ReservedFile[]): Promise<void> {
    calls.push('reserveFiles')
    if (this.reserveDelayMs > 0) await sleep(this.reserveDelayMs)
    this.reserved.push(...files)
  }
  /** Como el UPDATE real: solo libera lo reservado que sigue `PENDING`, y devuelve eso. */
  async releaseFiles(
    ids: readonly string[],
    options: { signal?: AbortSignal } = {},
  ): Promise<string[]> {
    calls.push('releaseFiles')
    signals.push(['releaseFiles', options.signal])
    if (this.releaseError !== null) throw this.releaseError
    const pending = ids.filter(
      (id) =>
        this.reserved.some((file) => file.id === id) &&
        !this.attached.has(id) &&
        !this.released.includes(id),
    )
    this.released.push(...pending)
    return pending
  }
  async create(
    request: NewAdvanceRequest,
    outbox: (publicCode: string) => readonly NewOutboxMessage[],
    options: { signal?: AbortSignal } = {},
  ): Promise<CreateAdvanceRequestResult> {
    calls.push('create')
    signals.push(['create', options.signal])
    if (this.hangCreate) return untilAborted(options.signal)
    const next = this.results.shift() ?? { kind: 'created', publicCode: 'ANT-2026-000001' }
    if (next instanceof Error) throw next
    if (next.kind === 'created') {
      this.created.push({ request, outbox: outbox(next.publicCode) })
      for (const id of request.fileIds) this.attached.add(id)
      if (this.loseCommitAck) throw new Error('se cortó la conexión después del COMMIT')
      if (this.slowCommitAckMs > 0) await sleep(this.slowCommitAckMs)
    }
    if (next.kind === 'invoice-conflict') this.openKeys = [...this.openKeysAfterConflict]
    return next
  }
}

class FakeStorage implements FileStoragePort {
  readonly bucket = 'anticipate-test'
  putError: Error | null = null
  /** Claves que `deleteQuietly` informa como no borradas. */
  keepOnDelete: (key: string) => boolean = () => false
  put: PutFileInput[] = []
  deleted: string[] = []
  /** `putAll` no responde hasta que se cancela la señal. */
  hangPut = false
  /** `deleteQuietly` no responde hasta que se cancela la señal; entonces devuelve todas las claves. */
  hangDelete = false

  async putAll(
    inputs: readonly PutFileInput[],
    options: { signal?: AbortSignal } = {},
  ): Promise<StoredObject[]> {
    calls.push('putAll')
    signals.push(['putAll', options.signal])
    if (this.hangPut) return untilAborted(options.signal)
    if (this.putError !== null) throw this.putError
    this.put.push(...inputs)
    return inputs.map(({ key, body }) => ({
      bucket: this.bucket,
      key,
      sizeBytes: body.length,
      sha256: sha256(body),
    }))
  }
  async deleteQuietly(
    keys: readonly string[],
    options: { signal?: AbortSignal } = {},
  ): Promise<string[]> {
    calls.push('deleteQuietly')
    signals.push(['deleteQuietly', options.signal])
    if (this.hangDelete) {
      await untilAborted(options.signal).catch(() => undefined)
      return [...keys]
    }
    this.deleted.push(...keys)
    return keys.filter((key) => this.keepOnDelete(key))
  }
  async exists(): Promise<boolean> {
    return false
  }
  async downloadUrl(): Promise<string> {
    return 'https://example.test'
  }
}

let repository: FakeRepository
let storage: FakeStorage
let currentVersions: Set<string>
let payer: PayerConditions | null
let notified: number
let useCase: CreateAdvanceRequestUseCase

/** Las dependencias de prueba con las fakes del test en curso; `overrides` cambia las que haga falta. */
function dependencies(
  overrides: Partial<CreateAdvanceRequestDependencies> = {},
): CreateAdvanceRequestDependencies {
  let sequence = 0
  return {
    repository,
    payerConditions: {
      findActiveBySlug: async (_slug, options = {}) => {
        signals.push(['findActiveBySlug', options.signal])
        return payer
      },
    },
    legalDocuments: {
      isCurrent: async (type, version, options = {}) => {
        signals.push(['isCurrent', options.signal])
        return currentVersions.has(`${type}:${version}`)
      },
    },
    invoiceIntake: new InvoiceIntakeService(
      { maxXmlBytes: 1_048_576, maxPdfBytes: 10_485_760 },
      new InlineInvoiceXmlParser(),
    ),
    storage,
    outboxWakeUp: { notify: () => notified++ },
    clock: { now: () => NOW },
    newId: () => `0192f3a0-0000-7000-8000-${String(++sequence).padStart(12, '0')}`,
    publicCodePrefix: 'ANT',
    submissionTimeoutMs: 60_000,
    cleanupTimeoutMs: 10_000,
    ...overrides,
  }
}

beforeEach(() => {
  calls = []
  signals = []
  repository = new FakeRepository()
  storage = new FakeStorage()
  currentVersions = new Set(['TERMS:2026-09', 'PERSONAL_DATA:2026-09'])
  payer = SEA
  notified = 0
  useCase = new CreateAdvanceRequestUseCase(dependencies())
})

function only<T>(items: readonly T[]): T {
  expect(items).toHaveLength(1)
  return items[0] as T
}

async function codesOf(promise: Promise<unknown>): Promise<string[]> {
  try {
    await promise
  } catch (error) {
    if (error instanceof BusinessRulesViolatedError) return error.problems.map((p) => p.code)
    if (isApplicationError(error)) return [error.publicCode]
    throw error
  }
  throw new Error('se esperaba un rechazo')
}

describe('CreateAdvanceRequestUseCase', () => {
  it('reserva, sube, guarda con el outbox y despierta al publicador, en ese orden', async () => {
    await expect(useCase.execute(input())).resolves.toEqual({
      publicCode: 'ANT-2026-000001',
      replayed: false,
    })
    expect(calls).toEqual([
      'findByIdempotencyKey',
      'findInvoiceKeysInOpenRequests',
      'reserveFiles',
      'putAll',
      'create',
    ])
    expect(notified).toBe(1)

    const { request, outbox } = only(repository.created)
    expect(request.fileIds).toEqual(repository.reserved.map(({ id }) => id))
    expect(
      repository.reserved.map(({ purpose, contentType, bucket }) => [purpose, contentType, bucket]),
    ).toEqual([
      ['INVOICE_XML', 'application/xml', 'anticipate-test'],
      ['INVOICE_PDF', 'application/pdf', 'anticipate-test'],
    ])
    expect(storage.put.map(({ key }) => key)).toEqual(repository.reserved.map(({ key }) => key))
    expect(request).toMatchObject({
      idempotencyKey: KEY,
      payerId: SEA.payerId,
      payerRuc: '20131312955',
      supplier: { ruc: '20100070970', legalName: 'PROVEEDOR EJEMPLO S.A.C.' },
      legalRepresentative: { dni: '46728673', fullName: 'Ana Pérez', jobTitle: null },
      currency: 'PEN',
      purpose: null,
      snapshot: {
        appliedAdvancePercent: 80,
        appliedMinTermDays: 15,
        totalNetPending: '10620.00',
        maxAmount: '8496.00',
      },
      correlationId: 'prueba-001',
      publicCodePrefix: 'ANT',
      publicCodeYear: 2026,
      createdAt: NOW,
    })
    expect(request.requestFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(request.invoices).toEqual([
      expect.objectContaining({
        invoiceKey: '20100070970|F001-123',
        dueDate: '2026-11-30',
        pdfFileId: repository.reserved[1]?.id,
        installments: [{ number: 1, label: 'Cuota001', amount: '10620.00', dueDate: '2026-11-30' }],
      }),
    ])
    expect(request.consents.map(({ type, ip }) => [type, ip])).toEqual([
      ['TERMS', '203.0.113.7'],
      ['PERSONAL_DATA', '203.0.113.7'],
    ])

    expect(outbox.map(({ handler }) => handler)).toEqual([
      'email.supplier-confirmation',
      'email.team-alert',
    ])
    expect(outbox[0]?.payload).toEqual({
      id: outbox[0]?.payload.id,
      type: 'advance-request.created',
      version: 1,
      occurredAt: NOW.toISOString(),
      aggregateId: request.id,
    })
    expect(JSON.stringify(outbox)).not.toContain('ana@proveedor.pe')
    expect(outbox.every(({ correlationId }) => correlationId === 'prueba-001')).toBe(true)
  })

  it('un reintento con la misma huella repite la respuesta sin subir nada', async () => {
    await useCase.execute(input())
    const fingerprint = repository.created[0]?.request.requestFingerprint ?? ''
    calls = []
    repository.existing = { publicCode: 'ANT-2026-000001', requestFingerprint: fingerprint }
    await expect(useCase.execute(input())).resolves.toEqual({
      publicCode: 'ANT-2026-000001',
      replayed: true,
    })
    expect(calls).toEqual(['findByIdempotencyKey'])
  })

  it('la misma clave con otra huella: IdempotencyKeyReusedError con la clave en el diagnóstico', async () => {
    repository.existing = { publicCode: 'ANT-2026-000001', requestFingerprint: 'f'.repeat(64) }
    const reused = useCase.execute(input())
    await expect(reused).rejects.toBeInstanceOf(IdempotencyKeyReusedError)
    await expect(reused).rejects.toThrow(`Idempotency-Key ${KEY} reutilizada con otra huella`)
  })

  it('un pagador que no está activo: PAYER_NOT_AVAILABLE y nada subido', async () => {
    payer = null
    expect(await codesOf(useCase.execute(input()))).toEqual(['PAYER_NOT_AVAILABLE'])
    expect(calls).not.toContain('reserveFiles')
  })

  it('versiones legales retiradas: CONSENT_VERSION_OUTDATED en cada campo', async () => {
    currentVersions = new Set()
    const error = await useCase.execute(input()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BusinessRulesViolatedError)
    expect((error as BusinessRulesViolatedError).problems.map((p) => [p.code, p.field])).toEqual([
      ['CONSENT_VERSION_OUTDATED', 'consents.termsVersion'],
      ['CONSENT_VERSION_OUTDATED', 'consents.privacyVersion'],
    ])
  })

  it('facturas con problemas: 422 con todos juntos y nada reservado', async () => {
    const codes = await codesOf(
      useCase.execute(
        input({
          xmlFiles: [xml('F001-123.xml', { issueDate: '2026-12-01' })],
          pdfFiles: [pdf('F001-9.pdf')],
        }),
      ),
    )
    expect(codes).toEqual(expect.arrayContaining(['ISSUE_DATE_IN_FUTURE', 'PDF_WITHOUT_XML']))
    expect(calls).not.toContain('reserveFiles')
  })

  it('una factura en otra solicitud abierta: INVOICE_ALREADY_IN_OPEN_REQUEST con factura y archivo', async () => {
    repository.openKeys = ['20100070970|F001-123']
    const error = await useCase.execute(input()).catch((e: unknown) => e)
    expect((error as BusinessRulesViolatedError).problems).toEqual([
      expect.objectContaining({
        code: 'INVOICE_ALREADY_IN_OPEN_REQUEST',
        invoice: 'F001-123',
        file: 'F001-123.xml',
      }),
    ])
    expect(calls).not.toContain('reserveFiles')
  })

  describe('D45: la solicitud de la misma clave confirma después de la búsqueda de la clave', () => {
    /** Huella de `input()`: la de la solicitud que guardó el envío original. */
    async function fingerprintOfInput(): Promise<string> {
      await useCase.execute(input())
      const fingerprint = only(repository.created).request.requestFingerprint
      repository.created = []
      repository.reserved = []
      calls = []
      return fingerprint
    }

    it('y toma sus facturas: responde como reintento, no 422 INVOICE_ALREADY_IN_OPEN_REQUEST', async () => {
      const fingerprint = await fingerprintOfInput()
      // La clave no aparece en el paso 2; cuando se buscan las facturas, el original ya confirmó.
      repository.openKeys = ['20100070970|F001-123']
      repository.winner = { publicCode: 'ANT-2026-000007', requestFingerprint: fingerprint }
      await expect(useCase.execute(input())).resolves.toEqual({
        publicCode: 'ANT-2026-000007',
        replayed: true,
      })
      expect(calls).toEqual([
        'findByIdempotencyKey',
        'findInvoiceKeysInOpenRequests',
        'findByIdempotencyKey',
      ])
      expect(repository.reserved).toEqual([])
    })

    it('con otra huella: 422 IDEMPOTENCY_KEY_REUSED, como si hubiera confirmado antes del paso 2', async () => {
      repository.openKeys = ['20100070970|F001-123']
      repository.winner = { publicCode: 'ANT-2026-000007', requestFingerprint: 'f'.repeat(64) }
      await expect(useCase.execute(input())).rejects.toBeInstanceOf(IdempotencyKeyReusedError)
      expect(calls).not.toContain('reserveFiles')
    })

    it('después de un choque de factura: libera lo suyo y responde como reintento', async () => {
      const fingerprint = await fingerprintOfInput()
      repository.results = [{ kind: 'invoice-conflict', invoiceKeys: ['20100070970|F001-123'] }]
      repository.openKeysAfterConflict = ['20100070970|F001-123']
      repository.winner = { publicCode: 'ANT-2026-000007', requestFingerprint: fingerprint }
      await expect(useCase.execute(input())).resolves.toEqual({
        publicCode: 'ANT-2026-000007',
        replayed: true,
      })
      expect(repository.released).toEqual(repository.reserved.map(({ id }) => id))
      expect(storage.deleted).toEqual(repository.reserved.map(({ key }) => key))
      expect(notified).toBe(1)
    })
  })

  it('si falla la subida: primero libera las filas, después borra sus objetos y responde 503', async () => {
    storage.putError = new Error('S3 caído')
    const error = await useCase.execute(input()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ServiceUnavailableError)
    expect(calls.slice(-2)).toEqual(['releaseFiles', 'deleteQuietly'])
    expect(repository.released).toEqual(repository.reserved.map(({ id }) => id))
    expect(storage.deleted).toEqual(repository.reserved.map(({ key }) => key))
    expect(calls).not.toContain('create')
  })

  it('un objeto que no se pudo borrar no cambia la respuesta: su fila ya quedó liberada para la purga', async () => {
    storage.putError = new Error('S3 caído')
    storage.keepOnDelete = (key) => key.endsWith('.xml')
    const error = await useCase.execute(input()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ServiceUnavailableError)
    expect(repository.released).toEqual(repository.reserved.map(({ id }) => id))
  })

  it('si la base no responde al liberar: no borra ningún objeto (sus filas quedan PENDING para el barrido)', async () => {
    storage.putError = new Error('S3 caído')
    repository.releaseError = new Error('base caída')
    const error = await useCase.execute(input()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ServiceUnavailableError)
    expect(storage.deleted).toEqual([])
  })

  it('si la transacción falla: libera, borra y responde 503', async () => {
    repository.results = [new Error('conexión perdida')]
    const error = await useCase.execute(input()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ServiceUnavailableError)
    expect(repository.released).toEqual(repository.reserved.map(({ id }) => id))
    expect(storage.deleted).toEqual(repository.reserved.map(({ key }) => key))
    expect(notified).toBe(0)
  })

  it('COMMIT ambiguo (confirmó, pero create lanzó): 503 sin borrar los objetos de la solicitud guardada', async () => {
    repository.loseCommitAck = true
    const error = await useCase.execute(input()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ServiceUnavailableError)
    expect(repository.created).toHaveLength(1)
    // Sus filas quedaron ATTACHED: nada se libera y ningún objeto se toca.
    expect(repository.released).toEqual([])
    expect(storage.deleted).toEqual([])
  })

  it('choque de clave con otro envío idéntico: borra lo suyo y responde como reintento', async () => {
    await useCase.execute(input())
    const fingerprint = repository.created[0]?.request.requestFingerprint ?? ''
    repository.created = []
    repository.reserved = []
    repository.results = [{ kind: 'idempotency-conflict' }]
    repository.winner = { publicCode: 'ANT-2026-000007', requestFingerprint: fingerprint }
    await expect(useCase.execute(input())).resolves.toEqual({
      publicCode: 'ANT-2026-000007',
      replayed: true,
    })
    expect(repository.released).toEqual(repository.reserved.map(({ id }) => id))
  })

  it('choque de factura: borra, libera y responde 422 si la factura quedó tomada', async () => {
    repository.results = [{ kind: 'invoice-conflict', invoiceKeys: ['20100070970|F001-123'] }]
    repository.openKeysAfterConflict = ['20100070970|F001-123']
    expect(await codesOf(useCase.execute(input()))).toEqual(['INVOICE_ALREADY_IN_OPEN_REQUEST'])
    expect(repository.released).toEqual(repository.reserved.map(({ id }) => id))
    expect(notified).toBe(0)
  })

  it('choque de factura que ya se liberó: reintenta con ids nuevos y guarda', async () => {
    repository.results = [{ kind: 'invoice-conflict', invoiceKeys: ['20100070970|F001-123'] }]
    await expect(useCase.execute(input())).resolves.toMatchObject({ replayed: false })
    const [first, second] = [repository.reserved.slice(0, 2), repository.reserved.slice(2)]
    expect(second).toHaveLength(2)
    expect(second.map(({ key }) => key)).not.toEqual(first.map(({ key }) => key))
    expect(repository.released).toEqual(first.map(({ id }) => id))
  })

  it(`tras ${MAX_CREATE_ATTEMPTS} choques de factura sin dueño: 503`, async () => {
    repository.results = Array.from({ length: MAX_CREATE_ATTEMPTS }, () => ({
      kind: 'invoice-conflict' as const,
      invoiceKeys: ['20100070970|F001-123'],
    }))
    expect(await codesOf(useCase.execute(input()))).toEqual(['SERVICE_UNAVAILABLE'])
  })
})

describe('CreateAdvanceRequestUseCase · plazo del envío (D57)', () => {
  const SHORT = { submissionTimeoutMs: 60, cleanupTimeoutMs: 60 }
  const shortUseCase = (overrides: Partial<CreateAdvanceRequestDependencies> = {}) =>
    new CreateAdvanceRequestUseCase(dependencies({ ...SHORT, ...overrides }))

  async function deadlineError(
    promise: Promise<unknown>,
  ): Promise<SubmissionDeadlineExceededError> {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(SubmissionDeadlineExceededError)
    return error as SubmissionDeadlineExceededError
  }

  it('cada dependencia recibe la señal del envío; la limpieza, una propia', async () => {
    repository.results = [{ kind: 'invoice-conflict', invoiceKeys: ['20100070970|F001-123'] }]
    const parsed: (AbortSignal | undefined)[] = []
    const parser = new InlineInvoiceXmlParser()
    const spying: InvoiceXmlParserPort = {
      parse: (xml, options) => {
        parsed.push(options.signal)
        return parser.parse(xml, options)
      },
    }
    const traced = new CreateAdvanceRequestUseCase(
      dependencies({
        invoiceIntake: new InvoiceIntakeService(
          { maxXmlBytes: 1_048_576, maxPdfBytes: 10_485_760 },
          spying,
        ),
      }),
    )
    await expect(traced.execute(input())).resolves.toMatchObject({ replayed: false })

    const submission = signals[0]?.[1]
    expect(submission).toBeInstanceOf(AbortSignal)
    expect(parsed).toEqual([submission])
    const cleanup = signals.filter(([call]) => call === 'releaseFiles' || call === 'deleteQuietly')
    expect(cleanup.map(([call]) => call)).toEqual(['releaseFiles', 'deleteQuietly'])
    for (const [, signal] of cleanup) expect(signal).not.toBe(submission)
    expect(signals.filter(([, signal]) => signal === submission).map(([call]) => call)).toEqual([
      'findByIdempotencyKey',
      'findActiveBySlug',
      'isCurrent',
      'isCurrent',
      'findInvoiceKeysInOpenRequests',
      'putAll',
      'create',
      'findInvoiceKeysInOpenRequests',
      'putAll',
      'create',
    ])
    expect(signals.every(([, signal]) => signal !== undefined)).toBe(true)
    // Terminó a tiempo: el temporizador del plazo se apagó y la señal nunca se cancela.
    expect(submission?.aborted).toBe(false)
  })

  it('un envío que termina a tiempo apaga su temporizador', async () => {
    await shortUseCase().execute(input())
    const submission = signals[0]?.[1]
    await sleep(SHORT.submissionTimeoutMs + 40)
    expect(submission?.aborted).toBe(false)
  })

  it('con una lectura colgada: 503 al vencer, con Retry-After y la etapa en el diagnóstico, sin reservar nada', async () => {
    const hanging = shortUseCase({
      payerConditions: { findActiveBySlug: (_slug, options = {}) => untilAborted(options.signal) },
    })
    const startedAt = Date.now()
    const error = await deadlineError(hanging.execute(input()))
    expect(Date.now() - startedAt).toBeLessThan(SHORT.submissionTimeoutMs + 150)
    expect(error).toBeInstanceOf(ServiceUnavailableError)
    expect(error.publicCode).toBe('SERVICE_UNAVAILABLE')
    expect(error.retryAfterSeconds).toBe(SUBMISSION_RETRY_AFTER_SECONDS)
    expect(error.message).toBe(
      'el envío no terminó en 60 ms (SUBMISSION_TIMEOUT_MS), durante: el pagador y las versiones legales',
    )
    expect(calls).not.toContain('reserveFiles')
  })

  it('aunque la dependencia no atienda la señal, la respuesta sale al vencer el plazo', async () => {
    const ignoring = shortUseCase({
      legalDocuments: { isCurrent: () => new Promise<boolean>(() => undefined) },
    })
    const startedAt = Date.now()
    await deadlineError(ignoring.execute(input()))
    expect(Date.now() - startedAt).toBeLessThan(SHORT.submissionTimeoutMs + 150)
  })

  it('con el lector de XML colgado: 503 durante la lectura de los XML', async () => {
    const hanging = shortUseCase({
      invoiceIntake: new InvoiceIntakeService(
        { maxXmlBytes: 1_048_576, maxPdfBytes: 10_485_760 },
        { parse: (_xml, options) => untilAborted(options.signal) },
      ),
    })
    const error = await deadlineError(hanging.execute(input()))
    expect(error.message).toMatch(/durante: la lectura de los XML$/)
  })

  it('con la subida colgada: la corta, libera y borra con la señal de la limpieza y responde 503', async () => {
    storage.hangPut = true
    const error = await deadlineError(shortUseCase().execute(input()))
    expect(error.message).toMatch(/durante: la reserva y la subida de los archivos$/)
    expect(calls.slice(-3)).toEqual(['putAll', 'releaseFiles', 'deleteQuietly'])
    expect(repository.released).toEqual(repository.reserved.map(({ id }) => id))
    expect(storage.deleted).toEqual(repository.reserved.map(({ key }) => key))
    const putSignal = signals.find(([call]) => call === 'putAll')?.[1]
    const releaseSignal = signals.find(([call]) => call === 'releaseFiles')?.[1]
    expect(putSignal?.aborted).toBe(true)
    expect(releaseSignal).not.toBe(putSignal)
    expect(calls).not.toContain('create')
  })

  it('la limpieza también tiene tope: con el almacenamiento sin borrar, la respuesta sale al vencer su plazo', async () => {
    storage.hangPut = true
    storage.hangDelete = true
    const startedAt = Date.now()
    await deadlineError(shortUseCase().execute(input()))
    const elapsed = Date.now() - startedAt
    expect(elapsed).toBeGreaterThanOrEqual(SHORT.submissionTimeoutMs + SHORT.cleanupTimeoutMs - 5)
    expect(elapsed).toBeLessThan(SHORT.submissionTimeoutMs + SHORT.cleanupTimeoutMs + 200)
    // Las filas quedaron liberadas: la purga borra los objetos que no se pudieron borrar aquí.
    expect(repository.released).toEqual(repository.reserved.map(({ id }) => id))
  })

  it('la reserva no se corta: si el plazo vence durante ella, libera lo reservado y responde 503 sin subir', async () => {
    repository.reserveDelayMs = SHORT.submissionTimeoutMs + 40
    await deadlineError(shortUseCase().execute(input()))
    expect(repository.released).toEqual(repository.reserved.map(({ id }) => id))
    expect(repository.reserved).toHaveLength(2)
    expect(calls).not.toContain('putAll')
  })

  it('en medio de la transacción que no confirmó: 503, libera y borra lo subido', async () => {
    repository.hangCreate = true
    const error = await deadlineError(shortUseCase().execute(input()))
    expect(error.message).toMatch(/durante: la transacción/)
    expect(repository.released).toEqual(repository.reserved.map(({ id }) => id))
    expect(storage.deleted).toEqual(repository.reserved.map(({ key }) => key))
    expect(notified).toBe(0)
  })

  it('COMMIT lento que confirma después del plazo: 503 sin tocar sus archivos, y el reintento lo devuelve', async () => {
    repository.slowCommitAckMs = SHORT.submissionTimeoutMs + 100
    const error = await deadlineError(shortUseCase().execute(input()))
    expect(error.message).toBe(
      'el envío no terminó en 60 ms (SUBMISSION_TIMEOUT_MS), durante: la transacción (pudo confirmar: un reintento con la misma Idempotency-Key lo resuelve)',
    )
    // Confirmó: sus filas quedaron ATTACHED, nada se libera y ningún objeto se toca.
    expect(repository.created).toHaveLength(1)
    expect(repository.released).toEqual([])
    expect(storage.deleted).toEqual([])

    const fingerprint = repository.created[0]?.request.requestFingerprint ?? ''
    repository.existing = { publicCode: 'ANT-2026-000001', requestFingerprint: fingerprint }
    repository.slowCommitAckMs = 0
    await expect(shortUseCase().execute(input())).resolves.toEqual({
      publicCode: 'ANT-2026-000001',
      replayed: true,
    })
  })

  it('rechaza plazos que no son enteros positivos', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => shortUseCase({ submissionTimeoutMs: bad })).toThrow(RangeError)
      expect(() => shortUseCase({ cleanupTimeoutMs: bad })).toThrow(RangeError)
    }
  })
})
