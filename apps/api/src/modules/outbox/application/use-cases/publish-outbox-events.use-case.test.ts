import { describe, expect, it, vi } from 'vitest'
import { PermanentEmailError, RetryableEmailError } from '#/modules/notifications/index.js'
import { OutboxAggregateNotFoundError } from '../../domain/exceptions/outbox-failure-code.js'
import type { ClaimedOutboxEvent } from '../../domain/types/outbox-event.types.js'
import type { OutboxEventHandler } from '../ports/outbox-event-handler.port.js'
import type { OutboxEventRepositoryPort } from '../ports/outbox-event-repository.port.js'
import {
  type PublishOutboxEventsOptions,
  PublishOutboxEventsUseCase,
} from './publish-outbox-events.use-case.js'

const HANDLER = 'email.test'
const AGGREGATE_ID = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b'

function claimed(overrides: Partial<ClaimedOutboxEvent> = {}): ClaimedOutboxEvent {
  return {
    id: '0192a3b4-c5d6-7e8f-9a0b-000000000001',
    leaseToken: '0192a3b4-c5d6-4e8f-9a0b-00000000aaaa',
    attempts: 1,
    maxAttempts: 8,
    handler: HANDLER,
    dedupeKey: `0192a3b4-c5d6-7e8f-9a0b-000000000099:${HANDLER}`,
    eventType: 'advance-request.created',
    payload: {
      id: '0192a3b4-c5d6-7e8f-9a0b-000000000099',
      type: 'advance-request.created',
      version: 1,
      occurredAt: '2026-09-24T15:00:00.000Z',
      aggregateId: AGGREGATE_ID,
    },
    aggregate: { kind: 'ADVANCE_REQUEST', id: AGGREGATE_ID },
    correlationId: 'corr-1',
    ...overrides,
  }
}

/** Repositorio en memoria: registra el orden de las llamadas y devuelve lo que el test pide. */
function fakeRepository(batches: ClaimedOutboxEvent[][], options: { renew?: boolean } = {}) {
  const calls: string[] = []
  const repository = {
    claimDue: vi.fn<OutboxEventRepositoryPort['claimDue']>(async () => {
      calls.push('claimDue')
      return batches.shift() ?? []
    }),
    renewLease: vi.fn<OutboxEventRepositoryPort['renewLease']>(async ({ id }) => {
      calls.push(`renewLease:${id}`)
      return options.renew ?? true
    }),
    markPublished: vi.fn<OutboxEventRepositoryPort['markPublished']>(async ({ id }) => {
      calls.push(`markPublished:${id}`)
      return true
    }),
    reschedule: vi.fn<OutboxEventRepositoryPort['reschedule']>(async ({ id }) => {
      calls.push(`reschedule:${id}`)
      return true
    }),
    markDeadLetter: vi.fn<OutboxEventRepositoryPort['markDeadLetter']>(async ({ id }) => {
      calls.push(`markDeadLetter:${id}`)
      return true
    }),
    deadLetterExhausted: vi.fn<OutboxEventRepositoryPort['deadLetterExhausted']>(async () => 0),
    purgePublished: vi.fn<OutboxEventRepositoryPort['purgePublished']>(async () => 0),
    countBacklog: vi.fn<OutboxEventRepositoryPort['countBacklog']>(async () => ({
      deadLetter: 0,
      late: 0,
    })),
    millisecondsUntilNextDue: vi.fn<OutboxEventRepositoryPort['millisecondsUntilNextDue']>(
      async () => null,
    ),
  } satisfies OutboxEventRepositoryPort
  return { repository, calls }
}

function handlerThat(
  handle: OutboxEventHandler['handle'],
  calls: string[] = [],
  name = HANDLER,
): OutboxEventHandler {
  return {
    handler: name,
    handle: async (event) => {
      calls.push(`handle:${event.id}`)
      return handle(event)
    },
  }
}

const OPTIONS: PublishOutboxEventsOptions = {
  leaseSeconds: 120,
  batchSize: 20,
  handlerTimeoutMs: 50,
  baseDelayMs: 30_000,
  maxDelayMs: 3_600_000,
  requiredHandlers: [],
}
const logger = { warn: vi.fn() }
const noJitter = () => 0.5

function useCase(
  repository: OutboxEventRepositoryPort,
  handlers: OutboxEventHandler[],
  options: Partial<PublishOutboxEventsOptions> = {},
) {
  return new PublishOutboxEventsUseCase(
    repository,
    handlers,
    { ...OPTIONS, ...options },
    logger,
    noJitter,
  )
}

describe('PublishOutboxEventsUseCase', () => {
  it('renueva el arriendo antes de ejecutar el handler y publica con el token del reclamo', async () => {
    const event = claimed()
    const { repository, calls } = fakeRepository([[event]])
    const handler = handlerThat(async () => ({ providerMessageId: 'msg-1' }), calls)
    await expect(useCase(repository, [handler]).execute()).resolves.toEqual({
      published: 1,
      retried: 0,
      deadLettered: 0,
      leaseLost: 0,
    })
    expect(calls).toEqual([
      'claimDue',
      `renewLease:${event.id}`,
      `handle:${event.id}`,
      `markPublished:${event.id}`,
    ])
    expect(repository.claimDue).toHaveBeenCalledWith({
      handlers: [HANDLER],
      leaseSeconds: 120,
      batchSize: 20,
    })
    expect(repository.markPublished).toHaveBeenCalledWith({
      id: event.id,
      leaseToken: event.leaseToken,
      providerMessageId: 'msg-1',
    })
    expect(repository.deadLetterExhausted).toHaveBeenCalledTimes(1)
  })

  it('si la renovación falla, salta el evento sin ejecutar el handler', async () => {
    const { repository, calls } = fakeRepository([[claimed()]], { renew: false })
    const handle = vi.fn<OutboxEventHandler['handle']>()
    const result = await useCase(repository, [handlerThat(handle, calls)]).execute()
    expect(result.leaseLost).toBe(1)
    expect(handle).not.toHaveBeenCalled()
    expect(repository.markPublished).not.toHaveBeenCalled()
  })

  it('un handler que no está registrado pasa el evento a DEAD_LETTER con HANDLER_MISSING', async () => {
    const event = claimed({ handler: 'email.other' })
    const { repository } = fakeRepository([[event]])
    const result = await useCase(repository, [
      handlerThat(async () => ({ providerMessageId: null })),
    ]).execute()
    expect(result.deadLettered).toBe(1)
    expect(repository.markDeadLetter).toHaveBeenCalledWith({
      id: event.id,
      leaseToken: event.leaseToken,
      failureCode: 'HANDLER_MISSING',
    })
  })

  it('un payload que no corresponde a la fila pasa a DEAD_LETTER con PAYLOAD_INVALID sin llegar al handler', async () => {
    const event = claimed({ eventType: 'advance-request.withdrawn' })
    const { repository } = fakeRepository([[event]])
    const handle = vi.fn<OutboxEventHandler['handle']>()
    await useCase(repository, [handlerThat(handle)]).execute()
    expect(handle).not.toHaveBeenCalled()
    expect(repository.markDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: 'PAYLOAD_INVALID' }),
    )
  })

  it('clasifica cada fallo con su código y decide reintento o DEAD_LETTER', async () => {
    const cases = [
      {
        error: new RetryableEmailError('Brevo 502 sin código'),
        code: 'EMAIL_RETRYABLE',
        retried: true,
      },
      {
        error: new PermanentEmailError('Brevo 400 invalid_parameter'),
        code: 'EMAIL_PERMANENT',
        retried: false,
      },
      {
        error: new OutboxAggregateNotFoundError({ kind: 'ADVANCE_REQUEST', id: AGGREGATE_ID }),
        code: 'AGGREGATE_NOT_FOUND',
        retried: false,
      },
      { error: new Error('se cayó el render'), code: 'UNEXPECTED', retried: true },
    ] as const
    for (const { error, code, retried } of cases) {
      const { repository } = fakeRepository([[claimed()]])
      await useCase(repository, [handlerThat(async () => Promise.reject(error))]).execute()
      const writer = retried ? repository.reschedule : repository.markDeadLetter
      expect(writer).toHaveBeenCalledWith(expect.objectContaining({ failureCode: code }))
    }
  })

  it('reprograma con espera exponencial o con la que pidió el proveedor, acotada al máximo', async () => {
    const backoff = fakeRepository([[claimed({ attempts: 2 })]])
    await useCase(backoff.repository, [
      handlerThat(async () => Promise.reject(new RetryableEmailError('Brevo 503 sin código'))),
    ]).execute()
    expect(backoff.repository.reschedule).toHaveBeenCalledWith(
      expect.objectContaining({ delaySeconds: 60, failureCode: 'EMAIL_RETRYABLE' }),
    )

    const asked = fakeRepository([[claimed()], [claimed()]])
    const failing = handlerThat(async () => Promise.reject(new RetryableEmailError('Brevo 429', 7)))
    await useCase(asked.repository, [failing]).execute()
    await useCase(asked.repository, [failing], { maxDelayMs: 5_000 }).execute()
    expect(asked.repository.reschedule.mock.calls.map(([p]) => p.delaySeconds)).toEqual([7, 5])
  })

  it('un handler que excede handlerTimeoutMs se reprograma con HANDLER_TIMEOUT', async () => {
    const { repository } = fakeRepository([[claimed()]])
    const hanging = handlerThat(() => new Promise(() => {}))
    const result = await useCase(repository, [hanging], { handlerTimeoutMs: 20 }).execute()
    expect(result.retried).toBe(1)
    expect(repository.reschedule).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: 'HANDLER_TIMEOUT' }),
    )
  })

  it('en el último intento un fallo reintentable pasa a DEAD_LETTER', async () => {
    const { repository } = fakeRepository([[claimed({ attempts: 8, maxAttempts: 8 })]])
    await useCase(repository, [
      handlerThat(async () => Promise.reject(new RetryableEmailError('Brevo 502 sin código'))),
    ]).execute()
    expect(repository.reschedule).not.toHaveBeenCalled()
    expect(repository.markDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: 'EMAIL_RETRYABLE' }),
    )
  })

  it('una escritura de vuelta que devuelve false se cuenta como arriendo perdido', async () => {
    const { repository } = fakeRepository([[claimed()]])
    repository.markPublished.mockResolvedValueOnce(false)
    const result = await useCase(repository, [
      handlerThat(async () => ({ providerMessageId: null })),
    ]).execute()
    expect(result).toEqual({ published: 0, retried: 0, deadLettered: 0, leaseLost: 1 })
  })

  it('reclama lotes mientras vengan llenos, hasta maxBatches', async () => {
    const full = [
      claimed({ id: '0192a3b4-c5d6-7e8f-9a0b-000000000011' }),
      claimed({ id: '0192a3b4-c5d6-7e8f-9a0b-000000000012' }),
    ]
    const { repository } = fakeRepository([full, full, full, full])
    const handler = handlerThat(async () => ({ providerMessageId: null }))
    const result = await useCase(repository, [handler], { batchSize: 2 }).execute({ maxBatches: 3 })
    expect(repository.claimDue).toHaveBeenCalledTimes(3)
    expect(result.published).toBe(6)
  })

  it('sin handlers no reclama nada y no consulta el próximo despertar', async () => {
    const { repository } = fakeRepository([])
    const publisher = useCase(repository, [])
    await publisher.execute()
    await expect(publisher.nextDueInMs()).resolves.toBeNull()
    expect(repository.claimDue).not.toHaveBeenCalled()
    expect(repository.millisecondsUntilNextDue).not.toHaveBeenCalled()
  })

  it('no se construye con nombres inválidos, repetidos o con un handler requerido que falta', () => {
    const { repository } = fakeRepository([])
    const ok = handlerThat(async () => ({ providerMessageId: null }))
    expect(() => useCase(repository, [handlerThat(ok.handle, [], 'Email Prueba')])).toThrow(
      /inválido/,
    )
    expect(() => useCase(repository, [ok, ok])).toThrow(/dos handlers/)
    expect(() =>
      useCase(repository, [ok], { requiredHandlers: [HANDLER, 'email.team-alert'] }),
    ).toThrow(/email\.team-alert/)
  })
})
