import { advanceRequestCreatedEventSchema } from '@anticipate/shared/advance-request'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { OutboxPayload } from '#/modules/outbox/domain/types/outbox-event.types.js'
import {
  type AdvanceRequestCreatedEventInput,
  type AdvanceRequestCreatedOutboxPayload,
  buildAdvanceRequestCreatedEvent,
  toAdvanceRequestCreatedOutboxPayload,
} from './advance-request-created-event.js'

const input: AdvanceRequestCreatedEventInput = {
  eventId: '0199a3b4-c5d9-7c55-8d66-7e8f9a0b1c2d',
  occurredAt: new Date('2026-09-24T15:00:00.000Z'),
  advanceRequestId: '0199a3b4-c5d7-7a11-8b22-3c4d5e6f7a8b',
  publicCode: 'ant-2026-000001',
  payerSlug: 'sea',
  supplierRuc: '20100070970',
  currency: 'PEN',
  requestedAmount: '8000.00',
  invoiceCount: 1,
  contactEmail: 'ana@proveedor.pe',
}

describe('buildAdvanceRequestCreatedEvent', () => {
  it('arma el evento del contrato de shared, ya canónico', () => {
    const event = buildAdvanceRequestCreatedEvent(input)
    expect(event).toEqual({
      id: input.eventId,
      occurredAt: '2026-09-24T15:00:00.000Z',
      version: 1,
      type: 'advance-request.created',
      payload: {
        advanceRequestId: input.advanceRequestId,
        publicCode: 'ANT-2026-000001',
        payerSlug: 'sea',
        supplierRuc: '20100070970',
        currency: 'PEN',
        requestedAmount: '8000.00',
        invoiceCount: 1,
        contactEmail: 'ana@proveedor.pe',
      },
    })
    expect(advanceRequestCreatedEventSchema.safeParse(event).success).toBe(true)
  })

  it('un dato inválido es un error de programación que nombra la ruta, nunca el valor', () => {
    const build = () =>
      buildAdvanceRequestCreatedEvent({ ...input, contactEmail: 'ana-sin-arroba', invoiceCount: 0 })
    expect(build).toThrow(TypeError)
    expect(build).toThrow(/payload\.contactEmail/)
    expect(build).toThrow(/payload\.invoiceCount/)
    expect(build).not.toThrow(/ana-sin-arroba/)
  })

  it('rechaza un id de evento que no es UUID', () => {
    expect(() => buildAdvanceRequestCreatedEvent({ ...input, eventId: 'evento-1' })).toThrow(
      /^.*: id$/,
    )
  })
})

describe('toAdvanceRequestCreatedOutboxPayload', () => {
  it('guarda solo identificadores, tipo, versión y fecha', () => {
    const payload = toAdvanceRequestCreatedOutboxPayload(buildAdvanceRequestCreatedEvent(input))
    expect(payload).toEqual({
      id: input.eventId,
      type: 'advance-request.created',
      version: 1,
      occurredAt: '2026-09-24T15:00:00.000Z',
      aggregateId: input.advanceRequestId,
    })
  })

  it('no lleva datos personales ni del envío', () => {
    const json = JSON.stringify(
      toAdvanceRequestCreatedOutboxPayload(buildAdvanceRequestCreatedEvent(input)),
    )
    for (const value of ['ana@proveedor.pe', '20100070970', '8000.00', 'ANT-2026-000001', 'sea']) {
      expect(json).not.toContain(value)
    }
  })

  it('es un OutboxPayload del módulo outbox', () => {
    expectTypeOf<AdvanceRequestCreatedOutboxPayload>().toExtend<OutboxPayload>()
  })
})
