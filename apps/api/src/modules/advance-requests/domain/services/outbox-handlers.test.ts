import { describe, expect, it } from 'vitest'
import {
  ADVANCE_REQUEST_OUTBOX_HANDLERS,
  advanceRequestOutboxDedupeKey,
} from './outbox-handlers.js'

/** Mismas reglas que `outbox_events_handler_check` y `handler VARCHAR(60)`. */
const HANDLER_FORMAT = /^[a-z0-9]+([.-][a-z0-9]+)*$/
const handlers = Object.values(ADVANCE_REQUEST_OUTBOX_HANDLERS)

describe('ADVANCE_REQUEST_OUTBOX_HANDLERS', () => {
  it('son los dos correos de una solicitud nueva', () => {
    expect(ADVANCE_REQUEST_OUTBOX_HANDLERS).toEqual({
      supplierConfirmation: 'email.supplier-confirmation',
      teamAlert: 'email.team-alert',
    })
  })

  it('cada nombre cumple el CHECK de la base y no se repite', () => {
    for (const handler of handlers) {
      expect(handler).toMatch(HANDLER_FORMAT)
      expect(handler.length).toBeLessThanOrEqual(60)
    }
    expect(new Set(handlers).size).toBe(handlers.length)
  })
})

describe('advanceRequestOutboxDedupeKey', () => {
  const eventId = '0199a3b4-c5d9-7c55-8d66-7e8f9a0b1c2d'

  it('es una por handler y evento', () => {
    expect(advanceRequestOutboxDedupeKey('email.team-alert', eventId)).toBe(
      `email.team-alert:${eventId}`,
    )
    expect(advanceRequestOutboxDedupeKey('email.supplier-confirmation', eventId)).not.toBe(
      advanceRequestOutboxDedupeKey('email.team-alert', eventId),
    )
  })

  it('cabe en dedupe_key VARCHAR(200)', () => {
    for (const handler of handlers) {
      expect(advanceRequestOutboxDedupeKey(handler, eventId).length).toBeLessThanOrEqual(200)
    }
  })
})
