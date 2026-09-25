import { describe, expect, it } from 'vitest'
import type { NewOutboxMessage } from '../types/outbox-event.types.js'
import { hasValidOutboxPayload, isOutboxPayload, outboxMessageProblem } from './outbox-message.js'

const aggregateId = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b'
const message: NewOutboxMessage = {
  handler: 'email.supplier-confirmation',
  dedupeKey: '0192a3b4-c5d6-7e8f-9a0b-000000000099:email.supplier-confirmation',
  eventType: 'advance-request.created',
  payload: {
    id: '0192a3b4-c5d6-7e8f-9a0b-000000000099',
    type: 'advance-request.created',
    version: 1,
    occurredAt: '2026-09-24T15:00:00.000Z',
    aggregateId,
  },
  aggregate: { kind: 'ADVANCE_REQUEST', id: aggregateId },
  correlationId: 'corr-1',
}

describe('payload del outbox', () => {
  it('acepta un payload con ids, tipo, versión 1 e instante ISO', () => {
    expect(isOutboxPayload(message.payload)).toBe(true)
    expect(hasValidOutboxPayload(message)).toBe(true)
  })

  it('rechaza formas inválidas', () => {
    for (const payload of [
      null,
      [],
      'texto',
      { ...message.payload, id: 'no-es-uuid' },
      { ...message.payload, version: 2 },
      { ...message.payload, type: ' ' },
      { ...message.payload, occurredAt: '24/09/2026' },
      { ...message.payload, aggregateId: undefined },
    ]) {
      expect(isOutboxPayload(payload)).toBe(false)
    }
  })

  it('exige el mismo tipo de evento y el mismo agregado que la fila', () => {
    expect(hasValidOutboxPayload({ ...message, eventType: 'advance-request.withdrawn' })).toBe(
      false,
    )
    expect(
      hasValidOutboxPayload({
        ...message,
        aggregate: { kind: 'ADVANCE_REQUEST', id: '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6c' },
      }),
    ).toBe(false)
  })

  it('outboxMessageProblem explica por qué un mensaje no se puede encolar', () => {
    expect(outboxMessageProblem(message)).toBeNull()
    expect(outboxMessageProblem({ ...message, handler: 'Email Confirmación' })).toBe(
      'handler inválido',
    )
    expect(outboxMessageProblem({ ...message, dedupeKey: 'x'.repeat(201) })).toMatch(/dedupeKey/)
    expect(outboxMessageProblem({ ...message, eventType: 'otro' })).toMatch(/payload/)
  })
})
