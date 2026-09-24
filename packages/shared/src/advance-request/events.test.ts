import { describe, expect, it } from 'vitest'
import { domainEventSchema, EVENT_TYPES } from './events.js'

const created = {
  id: '6f1c2c1e-3b7d-4c39-9a3e-7d2f9d8e1a11',
  occurredAt: '2026-09-24T15:00:00.000Z',
  version: 1,
  type: 'advance-request.created',
  payload: {
    advanceRequestId: '0b4e6c2d-5b1a-4f6e-8c2d-1a2b3c4d5e6f',
    publicCode: 'ANT-2026-000123',
    payerSlug: 'sea',
    supplierRuc: '20100070970',
    currency: 'PEN',
    requestedAmount: '8000.00',
    invoiceCount: 2,
    contactEmail: 'ana@proveedor.pe',
  },
}

describe('domainEventSchema', () => {
  it('acepta un evento de creación y discrimina por tipo', () => {
    const r = domainEventSchema.parse(created)
    expect(r.type).toBe('advance-request.created')
    if (r.type === 'advance-request.created') expect(r.payload.invoiceCount).toBe(2)
  })

  it('acepta un cambio de estado con motivo y usuario nulos', () => {
    const r = domainEventSchema.safeParse({
      ...created,
      type: 'advance-request.status-changed',
      payload: {
        advanceRequestId: created.payload.advanceRequestId,
        publicCode: 'ANT-2026-000123',
        from: 'NEW',
        to: 'CONTACTED',
        closeReason: null,
        changedByUserId: null,
      },
    })
    expect(r.success).toBe(true)
  })

  it('rechaza tipos desconocidos, fechas sin zona y montos sin formato', () => {
    expect(
      domainEventSchema.safeParse({ ...created, type: 'advance-request.deleted' }).success,
    ).toBe(false)
    expect(
      domainEventSchema.safeParse({ ...created, occurredAt: '2026-09-24 15:00' }).success,
    ).toBe(false)
    expect(
      domainEventSchema.safeParse({
        ...created,
        payload: { ...created.payload, requestedAmount: '8000' },
      }).success,
    ).toBe(false)
  })

  it('el slug del pagador y el código público usan los esquemas del dominio', () => {
    for (const payerSlug of ['SEA', 'sea x', '-sea', 'a'.repeat(61)]) {
      expect(
        domainEventSchema.safeParse({ ...created, payload: { ...created.payload, payerSlug } })
          .success,
        payerSlug,
      ).toBe(false)
    }
    for (const publicCode of ['x', 'ANT-26-1', 'ANT-2026-12']) {
      expect(
        domainEventSchema.safeParse({ ...created, payload: { ...created.payload, publicCode } })
          .success,
        publicCode,
      ).toBe(false)
    }
  })

  it('EVENT_TYPES cubre exactamente los tipos de la unión', () => {
    expect([...EVENT_TYPES].sort()).toEqual([
      'advance-request.created',
      'advance-request.status-changed',
    ])
  })
})
