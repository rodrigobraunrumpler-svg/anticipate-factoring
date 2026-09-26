import { setTimeout as sleep } from 'node:timers/promises'
import { Inject, Injectable, Module } from '@nestjs/common'
import { Test, type TestingModule } from '@nestjs/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppConfigModule } from '#/common/config/index.js'
import {
  BrevoEmailSender,
  FakeEmailSender,
  NotificationsInfrastructureModule,
} from '#/infrastructure/notifications/index.js'
import { newId } from '#/infrastructure/prisma/id.js'
import { PrismaModule } from '#/infrastructure/prisma/prisma.module.js'
import type { PrismaService } from '#/infrastructure/prisma/prisma.service.js'
import { insertOutboxMessages } from '#/infrastructure/prisma/repositories/outbox/outbox-rows.js'
import { PrismaOutboxEventRepository } from '#/infrastructure/prisma/repositories/outbox/prisma-outbox-event.repository.js'
import {
  EMAIL_SENDER,
  type EmailSenderPort,
  type OutgoingEmail,
  PermanentEmailError,
  RetryableEmailError,
} from '#/modules/notifications/index.js'
import {
  type ClaimedOutboxEvent,
  type NewOutboxMessage,
  OUTBOX_EVENT_REPOSITORY,
  OUTBOX_WAKE_UP,
  OutboxAggregateNotFoundError,
  type OutboxEventHandler,
  type OutboxEventRepositoryPort,
  OutboxModule,
  OutboxWakeUpSignal,
  type PublishOutboxEventsResult,
  PublishOutboxEventsUseCase,
  PurgePublishedEventsUseCase,
} from '#/modules/outbox/index.js'
import {
  OutboxPublisherModule,
  type OutboxPublisherModuleOptions,
} from '#/workers/outbox-publisher/outbox-publisher.module.js'
import { createTestApp } from '../support/app.js'
import { testConfig } from '../support/config.js'
import { createTestPrisma, truncateAll } from '../support/db.js'
import { createCompleteAdvanceRequest, createOutboxEvent } from '../support/factories.js'

const TEST_HANDLER = 'email.test'
const HOUR_MS = '3600000'

/** El correo de prueba de un evento: la clave de idempotencia es el id de la fila. */
const emailOf = (event: ClaimedOutboxEvent): OutgoingEmail => ({
  to: { email: 'equipo@anticipate.local' },
  subject: `Evento ${event.id}`,
  html: '<p>prueba</p>',
  text: 'prueba',
  idempotencyKey: event.id,
  tags: [event.handler],
})

/** Handler de prueba: manda un correo por `EMAIL_SENDER`. `before` deja que cada test intervenga. */
@Injectable()
class ScriptedEmailHandler implements OutboxEventHandler {
  readonly handler = TEST_HANDLER
  readonly calls: ClaimedOutboxEvent[] = []
  before: (event: ClaimedOutboxEvent, signal: AbortSignal) => Promise<void> = async () => {}

  constructor(@Inject(EMAIL_SENDER) private readonly sender: EmailSenderPort) {}

  async handle(event: ClaimedOutboxEvent, signal: AbortSignal) {
    this.calls.push(event)
    await this.before(event, signal)
    return this.sender.send(emailOf(event), signal)
  }
}

/** Un handler que respeta el aviso de tope: rechaza con su motivo, como los adaptadores de correo. */
const untilAborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })

@Module({ providers: [ScriptedEmailHandler], exports: [ScriptedEmailHandler] })
class TestHandlersModule {}

const PUBLISHER_OPTIONS: OutboxPublisherModuleOptions = {
  imports: [TestHandlersModule],
  handlers: [ScriptedEmailHandler],
  requiredHandlers: [TEST_HANDLER],
}

/** El publicador sin AppModule: configuración, base, correo fake, señal y un handler de prueba. */
function compilePublisher(
  env: Record<string, string> = {},
  options: OutboxPublisherModuleOptions = PUBLISHER_OPTIONS,
): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [
      AppConfigModule.register(testConfig(env)),
      PrismaModule,
      NotificationsInfrastructureModule,
      OutboxModule,
      OutboxPublisherModule.forRoot(options),
    ],
  }).compile()
}

async function startPublisher(env: Record<string, string> = {}): Promise<TestingModule> {
  const moduleRef = await compilePublisher(env)
  await moduleRef.init()
  return moduleRef
}

const db = createTestPrisma()
let moduleRef: TestingModule
let publisher: PublishOutboxEventsUseCase
let repository: OutboxEventRepositoryPort
let handler: ScriptedEmailHandler
let mailer: FakeEmailSender
let requestId: string

function message(overrides: Partial<NewOutboxMessage> = {}): NewOutboxMessage {
  const eventId = newId()
  const handlerName = overrides.handler ?? TEST_HANDLER
  return {
    handler: handlerName,
    dedupeKey: `${eventId}:${handlerName}`,
    eventType: 'advance-request.created',
    payload: {
      id: eventId,
      type: 'advance-request.created',
      version: 1,
      occurredAt: new Date().toISOString(),
      aggregateId: requestId,
    },
    aggregate: { kind: 'ADVANCE_REQUEST', id: requestId },
    correlationId: 'corr-outbox-test',
    ...overrides,
  }
}

const enqueue = (messages: NewOutboxMessage[], maxAttempts = 8) =>
  insertOutboxMessages(db.prisma, messages, { maxAttempts })

/** Filas por id: UUIDv7, así que en orden de creación. */
const rows = () => db.prisma.outboxEvent.findMany({ orderBy: { id: 'asc' } })

function only<T>(items: readonly T[]): T {
  const [item] = items
  if (item === undefined || items.length !== 1)
    throw new Error(`se esperaba un elemento y hay ${items.length}`)
  return item
}

const claim = () =>
  repository.claimDue({ handlers: [TEST_HANDLER], leaseSeconds: 120, batchSize: 50 })

/** Opciones de un publicador armado a mano: otra réplica, o la versión anterior durante un despliegue. */
const OTHER_PUBLISHER_OPTIONS = {
  leaseSeconds: 120,
  batchSize: 20,
  handlerTimeoutMs: 5_000,
  baseDelayMs: 30_000,
  maxDelayMs: 3_600_000,
  requiredHandlers: [TEST_HANDLER],
}
const silentLogger = { warn: () => {}, error: () => {} }

/** La espera de los pendientes ya venció. */
const makeDue = () =>
  db.prisma.$executeRaw`
    UPDATE outbox_events SET available_at = now() - interval '1 second' WHERE status = 'PENDING'`

/** Vence el arriendo de un evento en PROCESSING, como si su proceso se hubiera caído. */
const expireLease = (id: string) =>
  db.prisma.$executeRaw`
    UPDATE outbox_events SET lock_expires_at = now() - interval '1 second' WHERE id = ${id}::uuid`

/** Segundos hasta `available_at`, con el reloj de la base. */
async function secondsUntilAvailable(id: string): Promise<number> {
  const [row] = await db.prisma.$queryRaw<{ seconds: number }[]>`
    SELECT extract(epoch FROM available_at - now())::float8 AS seconds FROM outbox_events WHERE id = ${id}::uuid`
  return row?.seconds ?? Number.NaN
}

beforeAll(async () => {
  moduleRef = await startPublisher({ OUTBOX_PURGE_BATCH_SIZE: '2' })
  publisher = moduleRef.get(PublishOutboxEventsUseCase)
  repository = moduleRef.get<OutboxEventRepositoryPort>(OUTBOX_EVENT_REPOSITORY)
  handler = moduleRef.get(ScriptedEmailHandler)
  mailer = moduleRef.get<FakeEmailSender>(EMAIL_SENDER)
})

beforeEach(async () => {
  await truncateAll(db.prisma)
  requestId = (await createCompleteAdvanceRequest(db.prisma, {})).id
  handler.calls.length = 0
  handler.before = async () => {}
  mailer.reset()
})

afterAll(async () => {
  await moduleRef.close()
  await db.close()
})

describe('insertOutboxMessages', () => {
  it('escribe con los tiempos de la base y solo los campos de OutboxPayload', async () => {
    const base = message()
    const leaky = { ...base, payload: { ...base.payload, contactEmail: 'ana@proveedor.pe' } }
    const written = await db.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_sleep(0.2)`
      const count = await insertOutboxMessages(tx, [leaky], { maxAttempts: 5 })
      const [check] = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM outbox_events
         WHERE available_at = now()::timestamptz(3) AND created_at = now()::timestamptz(3)`
      return { count, withDatabaseTime: check?.n }
    })
    expect(written).toEqual({ count: 1, withDatabaseTime: 1 })
    const row = only(await rows())
    expect(row).toMatchObject({
      handler: TEST_HANDLER,
      dedupeKey: base.dedupeKey,
      eventType: 'advance-request.created',
      advanceRequestId: requestId,
      status: 'PENDING',
      attempts: 0,
      maxAttempts: 5,
      correlationId: 'corr-outbox-test',
    })
    expect(row.payload).toEqual(base.payload)
    expect(JSON.stringify(row.payload)).not.toContain('ana@proveedor.pe')
  })

  it('si la transacción del agregado se revierte, no queda ninguna fila', async () => {
    await expect(
      db.prisma.$transaction(async (tx) => {
        await insertOutboxMessages(tx, [message(), message()], { maxAttempts: 8 })
        throw new Error('falla después de encolar')
      }),
    ).rejects.toThrow('falla después de encolar')
    expect(await db.prisma.outboxEvent.count()).toBe(0)
  })

  it('la clave de deduplicación descarta un mensaje ya encolado', async () => {
    const once = message()
    await expect(enqueue([once])).resolves.toBe(1)
    await expect(enqueue([once])).resolves.toBe(0)
    expect(await db.prisma.outboxEvent.count()).toBe(1)
  })

  it('un mensaje de otro agregado lanza antes de escribir', async () => {
    await expect(
      enqueue([message({ aggregate: { kind: 'ADVANCE_REQUEST', id: newId() } })]),
    ).rejects.toThrow(/payload/)
    expect(await db.prisma.outboxEvent.count()).toBe(0)
  })
})

describe('PublishOutboxEventsUseCase contra PostgreSQL', () => {
  it('publica cada evento una vez, con la clave de idempotencia igual al id de la fila', async () => {
    await enqueue([message(), message()])
    await expect(publisher.execute()).resolves.toEqual({
      published: 2,
      retried: 0,
      deadLettered: 0,
      leaseLost: 0,
    })
    const published = await rows()
    for (const row of published) {
      expect(row).toMatchObject({
        status: 'PUBLISHED',
        attempts: 1,
        leaseToken: null,
        lockedAt: null,
      })
      expect(row.publishedAt).not.toBeNull()
      expect(row.providerMessageId).toMatch(/^fake-/)
    }
    expect(mailer.sent.map((sent) => sent.idempotencyKey).sort()).toEqual(
      published.map((row) => row.id).sort(),
    )
    await expect(publisher.execute()).resolves.toMatchObject({ published: 0 })
    expect(mailer.sent).toHaveLength(2)
  })

  it('un fallo reintentable vuelve a PENDING con la espera medida por la base', async () => {
    await enqueue([message()])
    mailer.failNext(new RetryableEmailError('Brevo 502 sin código'))
    await expect(publisher.execute()).resolves.toMatchObject({ retried: 1 })
    const row = only(await rows())
    expect(row).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      lastError: 'EMAIL_RETRYABLE',
      leaseToken: null,
    })
    const seconds = await secondsUntilAvailable(row.id)
    expect(seconds).toBeGreaterThan(25)
    expect(seconds).toBeLessThanOrEqual(33)
    const nextDue = await publisher.nextDueInMs()
    expect(nextDue).toBeGreaterThan(25_000)
    expect(nextDue).toBeLessThanOrEqual(33_000)

    await expect(publisher.execute()).resolves.toMatchObject({ published: 0, retried: 0 })
    await makeDue()
    await expect(publisher.execute()).resolves.toMatchObject({ published: 1 })
    expect(only(await rows())).toMatchObject({ status: 'PUBLISHED', attempts: 2 })
  })

  it('un fallo permanente pasa a DEAD_LETTER sin agotar los intentos', async () => {
    await enqueue([message()])
    mailer.failNext(new PermanentEmailError('Brevo 400 invalid_parameter'))
    await expect(publisher.execute()).resolves.toMatchObject({ deadLettered: 1 })
    expect(only(await rows())).toMatchObject({
      status: 'DEAD_LETTER',
      attempts: 1,
      lastError: 'EMAIL_PERMANENT',
      leaseToken: null,
    })
  })

  it('una racha de 401 de Brevo (clave rotada o IP no autorizada) se reintenta con EMAIL_ACCOUNT y no pierde ningún correo', async () => {
    await enqueue([message(), message(), message()])
    // fetch falso: nunca se llama a la API real de Brevo.
    const brevoFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 'unauthorized', message: 'Key not found' }), {
          status: 401,
        }),
    )
    vi.stubGlobal('fetch', brevoFetch)
    const brevo = new BrevoEmailSender({
      apiKey: 'xkeysib-prueba',
      fromEmail: 'no-reply@anticipate.local',
      fromName: 'Anticipate',
      requestTimeoutMs: 5_000,
    })
    const alerts = vi.fn()
    const viaBrevo = new PublishOutboxEventsUseCase(
      repository,
      [{ handler: TEST_HANDLER, handle: (event, signal) => brevo.send(emailOf(event), signal) }],
      OTHER_PUBLISHER_OPTIONS,
      { warn: () => {}, error: alerts },
    )
    try {
      await expect(viaBrevo.execute()).resolves.toEqual({
        published: 0,
        retried: 3,
        deadLettered: 0,
        leaseLost: 0,
      })
      for (const row of await rows()) {
        expect(row).toMatchObject({
          status: 'PENDING',
          attempts: 1,
          lastError: 'EMAIL_ACCOUNT',
          leaseToken: null,
        })
      }
      expect(alerts).toHaveBeenCalledTimes(3)
      expect(alerts).toHaveBeenCalledWith(
        expect.objectContaining({ failureCode: 'EMAIL_ACCOUNT', detail: 'Brevo 401 unauthorized' }),
        expect.any(String),
      )
      expect(JSON.stringify(alerts.mock.calls)).not.toContain('xkeysib-prueba')

      // Se corrige la clave: el intento siguiente de cada correo sale.
      brevoFetch.mockImplementation(
        async () => new Response(JSON.stringify({ messageId: '<ok@brevo>' }), { status: 201 }),
      )
      await makeDue()
      await expect(viaBrevo.execute()).resolves.toMatchObject({ published: 3, deadLettered: 0 })
      for (const row of await rows()) {
        expect(row).toMatchObject({
          status: 'PUBLISHED',
          attempts: 2,
          providerMessageId: '<ok@brevo>',
        })
      }
      expect(brevoFetch).toHaveBeenCalledTimes(6)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('al agotar los intentos queda en DEAD_LETTER con el código del último fallo', async () => {
    await enqueue([message()], 2)
    mailer.failNext(new RetryableEmailError('red'), 2)
    await publisher.execute()
    await makeDue()
    await expect(publisher.execute()).resolves.toMatchObject({ deadLettered: 1 })
    expect(only(await rows())).toMatchObject({
      status: 'DEAD_LETTER',
      attempts: 2,
      lastError: 'EMAIL_RETRYABLE',
    })
  })

  it('un agregado inexistente y un payload de otro agregado pasan a DEAD_LETTER con su código', async () => {
    await enqueue([message()])
    handler.before = async (event) => {
      throw new OutboxAggregateNotFoundError(event.aggregate)
    }
    await publisher.execute()
    expect(only(await rows())).toMatchObject({
      status: 'DEAD_LETTER',
      lastError: 'AGGREGATE_NOT_FOUND',
    })

    await truncateAll(db.prisma)
    requestId = (await createCompleteAdvanceRequest(db.prisma, {})).id
    handler.calls.length = 0
    const eventId = newId()
    // Escrita sin insertOutboxMessages: el payload habla de otro agregado.
    await db.prisma.outboxEvent.create({
      data: {
        handler: TEST_HANDLER,
        dedupeKey: `${eventId}:${TEST_HANDLER}`,
        eventType: 'advance-request.created',
        payload: {
          id: eventId,
          type: 'advance-request.created',
          version: 1,
          occurredAt: new Date().toISOString(),
          aggregateId: newId(),
        },
        advanceRequestId: requestId,
        maxAttempts: 8,
      },
    })
    await publisher.execute()
    expect(handler.calls).toEqual([])
    expect(only(await rows())).toMatchObject({
      status: 'DEAD_LETTER',
      lastError: 'PAYLOAD_INVALID',
    })
  })

  it('un handler que excede OUTBOX_HANDLER_TIMEOUT_MS recibe el aviso y se reprograma con HANDLER_TIMEOUT', async () => {
    const slow = await startPublisher({ OUTBOX_HANDLER_TIMEOUT_MS: '100' })
    try {
      slow.get(ScriptedEmailHandler).before = (_event, signal) => untilAborted(signal)
      await enqueue([message()])
      await expect(slow.get(PublishOutboxEventsUseCase).execute()).resolves.toMatchObject({
        retried: 1,
      })
      expect(only(await rows())).toMatchObject({
        status: 'PENDING',
        attempts: 1,
        lastError: 'HANDLER_TIMEOUT',
      })
      expect(slow.get<FakeEmailSender>(EMAIL_SENDER).sent).toEqual([])
    } finally {
      await slow.close()
    }
  })

  it('tras el aviso de tope espera a que el handler termine: el envío tardío no sale y recién entonces reprograma', async () => {
    const slow = await startPublisher({ OUTBOX_HANDLER_TIMEOUT_MS: '100' })
    try {
      let handlerFinished = false
      // No hace caso del aviso: termina lo suyo y después intenta enviar con la señal ya abortada.
      slow.get(ScriptedEmailHandler).before = async () => {
        await sleep(300)
        handlerFinished = true
      }
      await enqueue([message()])
      await expect(slow.get(PublishOutboxEventsUseCase).execute()).resolves.toMatchObject({
        retried: 1,
      })
      expect(handlerFinished).toBe(true)
      await sleep(300)
      expect(slow.get<FakeEmailSender>(EMAIL_SENDER).sent).toEqual([])
      expect(only(await rows())).toMatchObject({
        status: 'PENDING',
        attempts: 1,
        lastError: 'HANDLER_TIMEOUT',
        leaseToken: null,
      })
    } finally {
      await slow.close()
    }
  })

  it('un handler que no termina tras el aviso queda abandonado: la fila conserva su arriendo hasta que vence', async () => {
    const slow = await startPublisher({
      OUTBOX_HANDLER_TIMEOUT_MS: '100',
      OUTBOX_LEASE_SECONDS: '1',
    })
    try {
      const slowHandler = slow.get(ScriptedEmailHandler)
      const slowPublisher = slow.get(PublishOutboxEventsUseCase)
      slowHandler.before = () => new Promise(() => {})
      await enqueue([message()])
      const startedAt = performance.now()
      await expect(slowPublisher.execute()).resolves.toEqual({
        published: 0,
        retried: 0,
        deadLettered: 0,
        leaseLost: 1,
      })
      // Espera mientras al arriendo (1 s) le quede OUTBOX_HANDLER_TIMEOUT_MS para escribir.
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(800)
      const abandoned = only(await rows())
      expect(abandoned).toMatchObject({ status: 'PROCESSING', attempts: 1, lastError: null })
      expect(abandoned.leaseToken).not.toBeNull()

      // Vencido el arriendo, otra pasada lo retoma como un intento nuevo.
      slowHandler.before = async () => {}
      await vi.waitFor(
        async () => expect(await slowPublisher.execute()).toMatchObject({ published: 1 }),
        { timeout: 5_000, interval: 100 },
      )
      expect(only(await rows())).toMatchObject({ status: 'PUBLISHED', attempts: 2 })
    } finally {
      await slow.close()
    }
  })

  it('una versión que no conoce un handler no reclama sus filas', async () => {
    await enqueue([message({ handler: 'email.other' })])
    await expect(publisher.execute()).resolves.toEqual({
      published: 0,
      retried: 0,
      deadLettered: 0,
      leaseLost: 0,
    })
    expect(only(await rows())).toMatchObject({ status: 'PENDING', attempts: 0 })
    await expect(publisher.nextDueInMs()).resolves.toBeNull()
  })

  it('token de arriendo: las escrituras de un reclamo vencido devuelven false y no pisan al nuevo', async () => {
    await enqueue([message()])
    const first = only(await claim())
    await expect(claim()).resolves.toEqual([])
    await expireLease(first.id)
    const second = only(await claim())
    // El primero nunca empezó: el segundo es el mismo primer intento.
    expect(second).toMatchObject({ id: first.id, attempts: 1 })
    expect(second.leaseToken).not.toBe(first.leaseToken)

    const stale = { id: first.id, leaseToken: first.leaseToken }
    await expect(
      Promise.all([
        repository.startAttempt({ ...stale, leaseSeconds: 120 }),
        repository.markPublished({ ...stale, providerMessageId: 'tarde' }),
        repository.reschedule({ ...stale, delaySeconds: 30, failureCode: 'EMAIL_RETRYABLE' }),
        repository.markDeadLetter({ ...stale, failureCode: 'UNEXPECTED' }),
        repository.releaseClaims({ claims: [stale] }),
      ]),
    ).resolves.toEqual([null, false, false, false, 0])

    const attemptToken = await repository.startAttempt({
      id: second.id,
      leaseToken: second.leaseToken,
      leaseSeconds: 120,
    })
    expect(attemptToken).not.toBeNull()
    expect(attemptToken).not.toBe(second.leaseToken)
    expect(only(await rows())).toMatchObject({ status: 'PROCESSING', attempts: 1 })
    // El token del reclamo ya no sirve: un intento se empieza una sola vez y no se devuelve.
    const claimOfSecond = { id: second.id, leaseToken: second.leaseToken }
    await expect(repository.startAttempt({ ...claimOfSecond, leaseSeconds: 120 })).resolves.toBe(
      null,
    )
    await expect(repository.releaseClaims({ claims: [claimOfSecond] })).resolves.toBe(0)
    await expect(
      repository.markPublished({
        id: second.id,
        leaseToken: attemptToken ?? '',
        providerMessageId: 'msg-b',
      }),
    ).resolves.toBe(true)
    expect(only(await rows())).toMatchObject({
      status: 'PUBLISHED',
      attempts: 1,
      providerMessageId: 'msg-b',
      leaseToken: null,
    })
  })

  it('releaseClaims devuelve a PENDING lo reclamado sin empezar, sin gastar intento', async () => {
    await enqueue([message(), message()])
    const [kept, released] = await claim()
    if (kept === undefined || released === undefined) throw new Error('se esperaban dos reclamos')
    await repository.startAttempt({ id: kept.id, leaseToken: kept.leaseToken, leaseSeconds: 120 })
    await expect(
      repository.releaseClaims({
        claims: [kept, released].map(({ id, leaseToken }) => ({ id, leaseToken })),
      }),
    ).resolves.toBe(1)
    const byId = new Map((await rows()).map((row) => [row.id, row]))
    expect(byId.get(released.id)).toMatchObject({
      status: 'PENDING',
      attempts: 0,
      leaseToken: null,
      lockedAt: null,
      lockExpiresAt: null,
    })
    expect(byId.get(kept.id)).toMatchObject({ status: 'PROCESSING', attempts: 1 })
    expect(only(await claim())).toMatchObject({ id: released.id, attempts: 1 })
  })

  it('un reclamo que vence sin empezar no gasta intento ni pasa a DEAD_LETTER', async () => {
    await enqueue([message()], 1)
    const first = only(await claim())
    expect(first.attempts).toBe(1)
    await expireLease(first.id)
    await expect(repository.deadLetterExhausted()).resolves.toBe(0)
    expect(only(await rows())).toMatchObject({ status: 'PROCESSING', attempts: 0 })
    expect(only(await claim())).toMatchObject({ id: first.id, attempts: 1 })
  })

  it('un lote lento: lo que otra instancia retoma antes de empezar se envía una vez, sin gastar intentos ni pasar a DEAD_LETTER', async () => {
    await enqueue([message(), message(), message()], 1)
    const ids = (await rows()).map((row) => row.id)
    // Otra réplica, o la versión anterior durante un despliegue, con su propio handler.
    const other = new PublishOutboxEventsUseCase(
      repository,
      [{ handler: TEST_HANDLER, handle: (event, signal) => mailer.send(emailOf(event), signal) }],
      OTHER_PUBLISHER_OPTIONS,
      silentLogger,
    )
    let otherResult: PublishOutboxEventsResult | undefined
    handler.before = async (event) => {
      if (otherResult !== undefined) return
      // Mientras se envía el primero, el arriendo del resto del lote vence y pasa la otra instancia.
      for (const id of ids) if (id !== event.id) await expireLease(id)
      otherResult = await other.execute()
    }
    await expect(publisher.execute()).resolves.toEqual({
      published: 1,
      retried: 0,
      deadLettered: 0,
      leaseLost: 2,
    })
    expect(otherResult).toEqual({ published: 2, retried: 0, deadLettered: 0, leaseLost: 0 })
    expect(mailer.sent.map((sent) => sent.idempotencyKey).sort()).toEqual([...ids].sort())
    for (const row of await rows()) {
      expect(row).toMatchObject({ status: 'PUBLISHED', attempts: 1, lastError: null })
    }
  })

  it('empieza cada intento con el token del reclamo: lo que otro proceso retomó no se envía', async () => {
    await enqueue([message(), message()])
    const ids = (await rows()).map((row) => row.id)
    let taken: string | undefined
    handler.before = async (event) => {
      if (taken !== undefined) return
      // Mientras se envía el primero, el arriendo del otro vence y otro proceso lo retoma.
      taken = ids.find((id) => id !== event.id) ?? ''
      await expireLease(taken)
      await claim()
    }
    await expect(publisher.execute()).resolves.toMatchObject({ published: 1, leaseLost: 1 })
    expect(mailer.sent.map((sent) => sent.idempotencyKey)).toEqual(ids.filter((id) => id !== taken))
    const byId = new Map((await rows()).map((row) => [row.id, row.status]))
    expect(byId.get(taken ?? '')).toBe('PROCESSING')
  })

  it('empezar el intento extiende un arriendo vencido que nadie retomó', async () => {
    await enqueue([message(), message()])
    const ids = (await rows()).map((row) => row.id)
    let expired = false
    handler.before = async (event) => {
      if (expired) return
      expired = true
      await expireLease(ids.find((id) => id !== event.id) ?? '')
    }
    await expect(publisher.execute()).resolves.toMatchObject({ published: 2, leaseLost: 0 })
  })

  it('un reclamo no espera ni toma las filas que otro reclamo tiene bloqueadas en su transacción (SKIP LOCKED)', async () => {
    await enqueue(Array.from({ length: 20 }, () => message()))
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let locked = () => {}
    const lockedByA = new Promise<void>((resolve) => {
      locked = resolve
    })
    let claimedByA: ClaimedOutboxEvent[] = []
    // A: el mismo reclamo, en una conexión propia, con la transacción abierta (sus filas bloqueadas).
    const a = db.prisma.$transaction(
      async (tx) => {
        const inTransaction = new PrismaOutboxEventRepository(tx as unknown as PrismaService)
        claimedByA = await inTransaction.claimDue({
          handlers: [TEST_HANDLER],
          leaseSeconds: 120,
          batchSize: 10,
        })
        locked()
        await held
      },
      { timeout: 15_000 },
    )
    let b: Promise<ClaimedOutboxEvent[]> | undefined
    try {
      await lockedByA
      // B: el publicador, por el pool de la app, mientras A sigue con sus filas bloqueadas.
      const startedAt = performance.now()
      b = claim()
      const claimedByB = await Promise.race([b, sleep(2_000).then(() => 'bloqueado' as const)])
      expect(claimedByB).not.toBe('bloqueado')
      expect(performance.now() - startedAt).toBeLessThan(1_000)
      const idsA = claimedByA.map((event) => event.id)
      const idsB = (claimedByB as ClaimedOutboxEvent[]).map((event) => event.id)
      expect(idsA).toHaveLength(10)
      expect(idsB).toHaveLength(10)
      expect(new Set([...idsA, ...idsB]).size).toBe(20)
    } finally {
      release()
      await a
      await b?.catch(() => [])
    }
  })

  it('dos procesos que reclaman a la vez nunca toman la misma fila', async () => {
    await enqueue(Array.from({ length: 20 }, () => message()))
    const [a, b] = await Promise.all([claim(), claim()])
    const ids = [...a, ...b].map((event) => event.id)
    expect(ids).toHaveLength(20)
    expect(new Set(ids).size).toBe(20)
  })

  it('un evento cuyo último intento empezó y nunca informó (el proceso cayó) pasa a DEAD_LETTER con UNEXPECTED', async () => {
    await enqueue([message()], 1)
    const claimed = only(await claim())
    await repository.startAttempt({
      id: claimed.id,
      leaseToken: claimed.leaseToken,
      leaseSeconds: 120,
    })
    await expireLease(claimed.id)
    await expect(publisher.execute()).resolves.toMatchObject({ deadLettered: 1 })
    expect(only(await rows())).toMatchObject({
      status: 'DEAD_LETTER',
      lastError: 'UNEXPECTED',
      leaseToken: null,
    })
  })

  it('markPublished guarda el providerMessageId hasta el largo de la columna (VARCHAR(255))', async () => {
    await enqueue([message()])
    const claimed = only(await claim())
    const attemptToken = await repository.startAttempt({
      id: claimed.id,
      leaseToken: claimed.leaseToken,
      leaseSeconds: 120,
    })
    await expect(
      repository.markPublished({
        id: claimed.id,
        leaseToken: attemptToken ?? '',
        providerMessageId: `<${'x'.repeat(300)}@brevo>`,
      }),
    ).resolves.toBe(true)
    expect(only(await rows()).providerMessageId).toBe(`<${'x'.repeat(254)}`)
  })

  it('la purga borra en lotes solo los PUBLISHED más viejos que la retención', async () => {
    const oldId = async () => {
      const [row] = await db.prisma.$queryRaw<
        { id: string }[]
      >`SELECT uuidv7(interval '-31 days')::text AS id`
      return row?.id ?? ''
    }
    for (let i = 0; i < 3; i++) {
      await createOutboxEvent(db.prisma, {
        advanceRequestId: requestId,
        id: await oldId(),
        status: 'PUBLISHED',
      })
    }
    const recent = await createOutboxEvent(db.prisma, {
      advanceRequestId: requestId,
      status: 'PUBLISHED',
    })
    const failed = await createOutboxEvent(db.prisma, {
      advanceRequestId: requestId,
      id: await oldId(),
      status: 'DEAD_LETTER',
    })
    await expect(moduleRef.get(PurgePublishedEventsUseCase).execute()).resolves.toBe(3)
    expect((await rows()).map((row) => row.id).sort()).toEqual([recent.id, failed.id].sort())
  })

  it('countBacklog cuenta los DEAD_LETTER y los atrasados', async () => {
    await createOutboxEvent(db.prisma, { advanceRequestId: requestId, status: 'DEAD_LETTER' })
    await enqueue([message(), message()])
    await db.prisma.$executeRaw`
      UPDATE outbox_events SET available_at = now() - interval '10 minutes' WHERE status = 'PENDING'`
    await expect(repository.countBacklog({ lateAfterSeconds: 300 })).resolves.toEqual({
      deadLetter: 1,
      late: 2,
    })
    await expect(repository.countBacklog({ lateAfterSeconds: 3_600 })).resolves.toEqual({
      deadLetter: 1,
      late: 0,
    })
  })
})

describe('OutboxPublisherModule.forRoot', () => {
  it('no arranca si falta un handler requerido o si dos comparten nombre', async () => {
    await expect(
      compilePublisher(
        {},
        { ...PUBLISHER_OPTIONS, requiredHandlers: [TEST_HANDLER, 'email.team-alert'] },
      ),
    ).rejects.toThrow(/email\.team-alert/)
    await expect(
      compilePublisher(
        {},
        { ...PUBLISHER_OPTIONS, handlers: [ScriptedEmailHandler, ScriptedEmailHandler] },
      ),
    ).rejects.toThrow(/dos handlers/)
  })

  it('AppModule registra el correo fake, la señal y el publicador', async () => {
    const app = await createTestApp()
    try {
      expect(app.get(EMAIL_SENDER)).toBeInstanceOf(FakeEmailSender)
      expect(app.get(OUTBOX_WAKE_UP)).toBeInstanceOf(OutboxWakeUpSignal)
      expect(app.get(PublishOutboxEventsUseCase)).toBeInstanceOf(PublishOutboxEventsUseCase)
    } finally {
      await app.close()
    }
  })
})

describe('OutboxPublisherScheduler', () => {
  /** Arranca el publicador con el sondeo encendido y espera a que termine el reclamo de la pasada inicial. */
  async function startScheduler(
    before?: (running: TestingModule) => void,
    env: Record<string, string> = {},
  ) {
    const running = await compilePublisher({
      OUTBOX_POLLER_ENABLED: 'true',
      OUTBOX_POLL_INTERVAL_MS: HOUR_MS,
      ...env,
    })
    before?.(running)
    const nextDue = vi.spyOn(running.get(PublishOutboxEventsUseCase), 'nextDueInMs')
    await running.init()
    await vi.waitFor(() => expect(nextDue).toHaveBeenCalled())
    return running
  }

  const waitForStatus = (status: string, attempts?: number) =>
    vi.waitFor(
      async () => {
        expect(only(await rows())).toMatchObject(
          attempts === undefined ? { status } : { status, attempts },
        )
      },
      { timeout: 5_000, interval: 50 },
    )

  it('con OUTBOX_POLLER_ENABLED=false no corre ninguna pasada', async () => {
    await enqueue([message()])
    moduleRef.get<OutboxWakeUpSignal>(OUTBOX_WAKE_UP).notify()
    await sleep(300)
    expect(handler.calls).toEqual([])
    expect(only(await rows())).toMatchObject({ status: 'PENDING', attempts: 0 })
  })

  it('OUTBOX_WAKE_UP despierta al publicador sin esperar el sondeo', async () => {
    const running = await startScheduler()
    try {
      await enqueue([message()])
      await sleep(300)
      expect(only(await rows())).toMatchObject({ status: 'PENDING' })
      running.get<OutboxWakeUpSignal>(OUTBOX_WAKE_UP).notify()
      await waitForStatus('PUBLISHED')
    } finally {
      await running.close()
    }
  })

  it('programa la pasada siguiente con el próximo available_at', async () => {
    const running = await startScheduler(
      (compiled) => {
        compiled
          .get<FakeEmailSender>(EMAIL_SENDER)
          .failNext(new RetryableEmailError('Brevo 429 too_many_requests', 1))
      },
      { OUTBOX_BASE_DELAY_MS: '1000' },
    )
    try {
      await enqueue([message()])
      running.get<OutboxWakeUpSignal>(OUTBOX_WAKE_UP).notify()
      // El primer intento se reprograma a 1 o 2 s (la exponencial de 1 s con su jitter, que es más que
      // lo que pidió el proveedor); nadie más avisa y el sondeo es de una hora.
      await waitForStatus('PUBLISHED', 2)
    } finally {
      await running.close()
    }
  })

  it('al apagar espera la pasada en curso, que termina de escribir antes de que se cierre la base', async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const running = await startScheduler((compiled) => {
      compiled.get(ScriptedEmailHandler).before = () => gate
    })
    await enqueue([message()])
    running.get<OutboxWakeUpSignal>(OUTBOX_WAKE_UP).notify()
    await vi.waitFor(() => expect(running.get(ScriptedEmailHandler).calls).toHaveLength(1))

    let closed = false
    const closing = running.close().then(() => {
      closed = true
    })
    await sleep(200)
    expect(closed).toBe(false)
    release()
    await closing
    expect(only(await rows())).toMatchObject({ status: 'PUBLISHED' })
  })

  it('al apagar no reclama más: termina el envío en curso y devuelve a PENDING lo reclamado sin empezar', async () => {
    let secondStarted = () => {}
    const second = new Promise<void>((resolve) => {
      secondStarted = resolve
    })
    const running = await startScheduler(
      (compiled) => {
        const scripted = compiled.get(ScriptedEmailHandler)
        scripted.before = async () => {
          if (scripted.calls.length === 2) secondStarted()
          await sleep(100)
        }
      },
      { OUTBOX_BATCH_SIZE: '4' },
    )
    const runningHandler = running.get(ScriptedEmailHandler)
    await enqueue(Array.from({ length: 10 }, () => message()))
    running.get<OutboxWakeUpSignal>(OUTBOX_WAKE_UP).notify()
    await second

    const closingAt = performance.now()
    await running.close()
    expect(performance.now() - closingAt).toBeLessThan(1_000)
    expect(runningHandler.calls).toHaveLength(2)
    expect(running.get<FakeEmailSender>(EMAIL_SENDER).sent).toHaveLength(2)
    const all = await rows()
    expect(all.filter((row) => row.status === 'PUBLISHED')).toHaveLength(2)
    for (const row of all.filter((row) => row.status !== 'PUBLISHED')) {
      expect(row).toMatchObject({ status: 'PENDING', attempts: 0, leaseToken: null })
    }
  })
})
