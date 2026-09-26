import { beforeEach, describe, expect, it, vi } from 'vitest'
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
const CLAIM_TOKEN = '0192a3b4-c5d6-4e8f-9a0b-00000000aaaa'
const ID_1 = '0192a3b4-c5d6-7e8f-9a0b-000000000001'
const ID_2 = '0192a3b4-c5d6-7e8f-9a0b-000000000002'
const ID_3 = '0192a3b4-c5d6-7e8f-9a0b-000000000003'

/** El token que `startAttempt` entrega para el intento (distinto del token del reclamo). */
const attemptToken = (id: string) => `intento-${id}`

function claimed(overrides: Partial<ClaimedOutboxEvent> = {}): ClaimedOutboxEvent {
  return {
    id: ID_1,
    leaseToken: CLAIM_TOKEN,
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
function fakeRepository(batches: ClaimedOutboxEvent[][], options: { start?: boolean } = {}) {
  const calls: string[] = []
  const repository = {
    claimDue: vi.fn<OutboxEventRepositoryPort['claimDue']>(async () => {
      calls.push('claimDue')
      return batches.shift() ?? []
    }),
    startAttempt: vi.fn<OutboxEventRepositoryPort['startAttempt']>(async ({ id }) => {
      calls.push(`startAttempt:${id}`)
      return (options.start ?? true) ? attemptToken(id) : null
    }),
    releaseClaims: vi.fn<OutboxEventRepositoryPort['releaseClaims']>(async ({ claims }) => {
      calls.push(`releaseClaims:${claims.map(({ id }) => id).join(',')}`)
      return claims.length
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
    handle: async (event, signal) => {
      calls.push(`handle:${event.id}`)
      return handle(event, signal)
    },
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Rechaza con el motivo del aviso, como un adaptador de correo que respeta la señal. */
const untilAborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })

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
const sent = async () => ({ providerMessageId: null })

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

beforeEach(() => {
  logger.warn.mockClear()
})

describe('PublishOutboxEventsUseCase', () => {
  it('empieza el intento antes de ejecutar el handler y escribe con el token del intento', async () => {
    const event = claimed()
    const { repository, calls } = fakeRepository([[event]])
    let received: { event: ClaimedOutboxEvent; signal: AbortSignal } | undefined
    const handler = handlerThat(async (attempt, signal) => {
      received = { event: attempt, signal }
      return { providerMessageId: 'msg-1' }
    }, calls)
    await expect(useCase(repository, [handler]).execute()).resolves.toEqual({
      published: 1,
      retried: 0,
      deadLettered: 0,
      leaseLost: 0,
    })
    expect(calls).toEqual([
      'claimDue',
      `startAttempt:${event.id}`,
      `handle:${event.id}`,
      `markPublished:${event.id}`,
    ])
    expect(repository.claimDue).toHaveBeenCalledWith({
      handlers: [HANDLER],
      leaseSeconds: 120,
      batchSize: 20,
    })
    expect(repository.startAttempt).toHaveBeenCalledWith({
      id: event.id,
      leaseToken: CLAIM_TOKEN,
      leaseSeconds: 120,
    })
    expect(received?.event).toEqual({ ...event, leaseToken: attemptToken(event.id) })
    expect(received?.signal.aborted).toBe(false)
    expect(repository.markPublished).toHaveBeenCalledWith({
      id: event.id,
      leaseToken: attemptToken(event.id),
      providerMessageId: 'msg-1',
    })
    expect(repository.releaseClaims).not.toHaveBeenCalled()
    expect(repository.deadLetterExhausted).toHaveBeenCalledTimes(1)
  })

  it('si el reclamo ya no es de este proceso, salta el evento sin ejecutar el handler', async () => {
    const { repository, calls } = fakeRepository([[claimed()]], { start: false })
    const handle = vi.fn<OutboxEventHandler['handle']>()
    const result = await useCase(repository, [handlerThat(handle, calls)]).execute()
    expect(result.leaseLost).toBe(1)
    expect(handle).not.toHaveBeenCalled()
    expect(repository.markPublished).not.toHaveBeenCalled()
  })

  it('un handler que no está registrado pasa el evento a DEAD_LETTER con HANDLER_MISSING', async () => {
    const event = claimed({ handler: 'email.other' })
    const { repository } = fakeRepository([[event]])
    const result = await useCase(repository, [handlerThat(sent)]).execute()
    expect(result.deadLettered).toBe(1)
    expect(repository.markDeadLetter).toHaveBeenCalledWith({
      id: event.id,
      leaseToken: attemptToken(event.id),
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

  it('al vencer handlerTimeoutMs avisa al handler y reprograma con HANDLER_TIMEOUT cuando terminó', async () => {
    const event = claimed()
    const { repository, calls } = fakeRepository([[event]])
    const handler = handlerThat(async (_attempt, signal) => {
      try {
        return await untilAborted(signal)
      } finally {
        calls.push('handler terminó')
      }
    }, calls)
    const result = await useCase(repository, [handler], { handlerTimeoutMs: 20 }).execute()
    expect(result.retried).toBe(1)
    expect(repository.reschedule).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseToken: attemptToken(event.id),
        failureCode: 'HANDLER_TIMEOUT',
      }),
    )
    expect(calls.slice(-2)).toEqual(['handler terminó', `reschedule:${event.id}`])
  })

  it('un handler que no hace caso del aviso se espera: no se reprograma mientras sigue corriendo', async () => {
    const event = claimed()
    const { repository, calls } = fakeRepository([[event]])
    const handler = handlerThat(async () => {
      await sleep(80)
      calls.push('handler terminó')
      throw new RetryableEmailError('Brevo sin respuesta (TimeoutError)')
    }, calls)
    await useCase(repository, [handler], { handlerTimeoutMs: 20 }).execute()
    expect(calls.slice(-2)).toEqual(['handler terminó', `reschedule:${event.id}`])
  })

  it('si el handler termina bien después del aviso, el correo salió: se publica y no se reprograma', async () => {
    const { repository } = fakeRepository([[claimed()]])
    const late = handlerThat(async () => {
      await sleep(80)
      return { providerMessageId: 'tarde' }
    })
    await expect(useCase(repository, [late], { handlerTimeoutMs: 20 }).execute()).resolves.toEqual({
      published: 1,
      retried: 0,
      deadLettered: 0,
      leaseLost: 0,
    })
    expect(repository.markPublished).toHaveBeenCalledWith(
      expect.objectContaining({ providerMessageId: 'tarde' }),
    )
    expect(repository.reschedule).not.toHaveBeenCalled()
  })

  it('un handler que no termina tras el aviso queda abandonado: no escribe nada y decide el vencimiento del arriendo', async () => {
    const event = claimed()
    const { repository } = fakeRepository([[event]])
    const hanging = handlerThat(() => new Promise(() => {}))
    const startedAt = performance.now()
    const result = await useCase(repository, [hanging], {
      leaseSeconds: 1,
      handlerTimeoutMs: 200,
    }).execute()
    const elapsed = performance.now() - startedAt
    expect(result).toEqual({ published: 0, retried: 0, deadLettered: 0, leaseLost: 1 })
    // Espera mientras al arriendo le quede handlerTimeoutMs para escribir: 1000 − 200 ms.
    expect(elapsed).toBeGreaterThanOrEqual(750)
    expect(elapsed).toBeLessThan(1_000)
    expect(repository.markPublished).not.toHaveBeenCalled()
    expect(repository.reschedule).not.toHaveBeenCalled()
    expect(repository.markDeadLetter).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: event.id, step: 'handlerAbandoned' }),
      expect.stringMatching(/no terminó/),
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
    const result = await useCase(repository, [handlerThat(sent)]).execute()
    expect(result).toEqual({ published: 0, retried: 0, deadLettered: 0, leaseLost: 1 })
  })

  it('reclama lotes mientras vengan llenos, hasta maxBatches', async () => {
    const full = [claimed({ id: ID_1 }), claimed({ id: ID_2 })]
    const { repository } = fakeRepository([full, full, full, full])
    const result = await useCase(repository, [handlerThat(sent)], { batchSize: 2 }).execute({
      maxBatches: 3,
    })
    expect(repository.claimDue).toHaveBeenCalledTimes(3)
    expect(result.published).toBe(6)
  })

  it('si una escritura falla a mitad de lote, devuelve lo reclamado sin empezar y propaga el error', async () => {
    const batch = [
      claimed({ id: ID_1 }),
      claimed({ id: ID_2, leaseToken: 'reclamo-2' }),
      claimed({ id: ID_3, leaseToken: 'reclamo-3' }),
    ]
    const { repository } = fakeRepository([batch])
    repository.startAttempt.mockImplementation(async ({ id }) => {
      if (id === ID_2) throw new Error('base caída')
      return attemptToken(id)
    })
    repository.releaseClaims.mockRejectedValueOnce(new Error('tampoco se pudo devolver'))
    await expect(useCase(repository, [handlerThat(sent)]).execute()).rejects.toThrow('base caída')
    // Con el token del reclamo: si el evento ya había empezado, la base no lo toca.
    expect(repository.releaseClaims).toHaveBeenCalledWith({
      claims: [
        { id: ID_2, leaseToken: 'reclamo-2' },
        { id: ID_3, leaseToken: 'reclamo-3' },
      ],
    })
  })

  describe('al apagar (señal de execute)', () => {
    it('con el apagado ya avisado no reclama nada', async () => {
      const stop = new AbortController()
      stop.abort()
      const { repository } = fakeRepository([[claimed()]])
      await expect(
        useCase(repository, [handlerThat(sent)]).execute({ signal: stop.signal }),
      ).resolves.toEqual({ published: 0, retried: 0, deadLettered: 0, leaseLost: 0 })
      expect(repository.claimDue).not.toHaveBeenCalled()
      expect(repository.deadLetterExhausted).not.toHaveBeenCalled()
    })

    it('termina el envío en curso, devuelve lo reclamado sin empezar y no reclama más', async () => {
      const stop = new AbortController()
      const batch = [
        claimed({ id: ID_1 }),
        claimed({ id: ID_2, leaseToken: 'reclamo-2' }),
        claimed({ id: ID_3, leaseToken: 'reclamo-3' }),
      ]
      const { repository, calls } = fakeRepository([batch, [claimed({ id: ID_1 })]])
      let handlerSignal: AbortSignal | undefined
      const handler = handlerThat(async (_attempt, signal) => {
        handlerSignal = signal
        stop.abort()
        await sleep(20)
        return { providerMessageId: 'msg' }
      }, calls)
      const result = await useCase(repository, [handler], { batchSize: 3 }).execute({
        signal: stop.signal,
      })
      expect(result).toEqual({ published: 1, retried: 0, deadLettered: 0, leaseLost: 0 })
      // El apagado no corta el envío en curso.
      expect(handlerSignal?.aborted).toBe(false)
      expect(calls).toEqual([
        'claimDue',
        `startAttempt:${ID_1}`,
        `handle:${ID_1}`,
        `markPublished:${ID_1}`,
        `releaseClaims:${ID_2},${ID_3}`,
      ])
      expect(repository.releaseClaims).toHaveBeenCalledWith({
        claims: [
          { id: ID_2, leaseToken: 'reclamo-2' },
          { id: ID_3, leaseToken: 'reclamo-3' },
        ],
      })
      expect(repository.deadLetterExhausted).not.toHaveBeenCalled()
    })

    it('si llega mientras espera a un handler que ya pasó su tope, lo abandona sin esperar al arriendo', async () => {
      const stop = new AbortController()
      const { repository } = fakeRepository([[claimed()]])
      const hanging = handlerThat(() => new Promise(() => {}))
      setTimeout(() => stop.abort(), 60)
      const startedAt = performance.now()
      const result = await useCase(repository, [hanging], { handlerTimeoutMs: 20 }).execute({
        signal: stop.signal,
      })
      expect(performance.now() - startedAt).toBeLessThan(500)
      expect(result.leaseLost).toBe(1)
      expect(repository.reschedule).not.toHaveBeenCalled()
      expect(repository.markPublished).not.toHaveBeenCalled()
    })
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
    const ok = handlerThat(sent)
    expect(() => useCase(repository, [handlerThat(ok.handle, [], 'Email Prueba')])).toThrow(
      /inválido/,
    )
    expect(() => useCase(repository, [ok, ok])).toThrow(/dos handlers/)
    expect(() =>
      useCase(repository, [ok], { requiredHandlers: [HANDLER, 'email.team-alert'] }),
    ).toThrow(/email\.team-alert/)
  })
})
