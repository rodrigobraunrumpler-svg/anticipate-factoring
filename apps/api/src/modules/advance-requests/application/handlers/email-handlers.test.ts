import { beforeEach, describe, expect, it } from 'vitest'
import type {
  AdvanceRequestNotificationReaderPort,
  AdvanceRequestNotificationView,
} from '#/modules/advance-requests/application/ports/advance-request-notification-reader.port.js'
import type { EmailSenderPort, OutgoingEmail } from '#/modules/notifications/index.js'
import { type ClaimedOutboxEvent, OutboxDeadLetterError } from '#/modules/outbox/index.js'
import { SupplierConfirmationEmailHandler } from './supplier-confirmation-email.handler.js'
import { TeamAlertEmailHandler } from './team-alert-email.handler.js'

const REQUEST_ID = '0192f3a0-0000-7000-8000-000000000001'
const EVENT_ID = '0192f3a0-0000-7000-8000-000000000099'

const VIEW: AdvanceRequestNotificationView = {
  id: REQUEST_ID,
  publicCode: 'ANT-2026-000001',
  payerShortName: 'SEA',
  supplierLegalName: 'PROVEEDOR EJEMPLO S.A.C.',
  supplierRuc: '20100070970',
  contactFullName: 'Ana Pérez',
  contactEmail: 'ana@proveedor.pe',
  requestedAmount: '8000.00',
  currency: 'PEN',
  invoiceCount: 2,
  createdAt: new Date('2026-09-24T15:00:00.000Z'),
}

const event = (overrides: Partial<ClaimedOutboxEvent> = {}): ClaimedOutboxEvent => ({
  id: EVENT_ID,
  handler: 'email.supplier-confirmation',
  dedupeKey: `email.supplier-confirmation:${EVENT_ID}`,
  eventType: 'advance-request.created',
  payload: {
    id: '0192f3a0-0000-7000-8000-000000000050',
    type: 'advance-request.created',
    version: 1,
    occurredAt: '2026-09-24T15:00:00.000Z',
    aggregateId: REQUEST_ID,
  },
  aggregate: { kind: 'ADVANCE_REQUEST', id: REQUEST_ID },
  correlationId: 'prueba-001',
  leaseToken: '0192f3a0-0000-7000-8000-000000000077',
  attempts: 1,
  maxAttempts: 8,
  ...overrides,
})

/** Como los adaptadores reales: con la señal ya abortada no envía y rechaza con su motivo. */
class RecordingSender implements EmailSenderPort {
  readonly sent: OutgoingEmail[] = []
  readonly signals: AbortSignal[] = []
  async send(
    email: OutgoingEmail,
    signal: AbortSignal,
  ): Promise<{ providerMessageId: string | null }> {
    signal.throwIfAborted()
    this.sent.push(email)
    this.signals.push(signal)
    return { providerMessageId: `prueba-${this.sent.length}` }
  }
}

let view: AdvanceRequestNotificationView | null
let sender: RecordingSender
/** El tope del publicador: la señal que recibe `handle`. */
let timeout: AbortController
const reader: AdvanceRequestNotificationReaderPort = { findById: async () => view }

beforeEach(() => {
  view = VIEW
  sender = new RecordingSender()
  timeout = new AbortController()
})

async function failureCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof OutboxDeadLetterError) return error.failureCode
    throw error
  }
  throw new Error('se esperaba un rechazo')
}

describe('SupplierConfirmationEmailHandler', () => {
  const handler = () => new SupplierConfirmationEmailHandler(reader, sender)

  it('se registra con su nombre de handler', () => {
    expect(handler().handler).toBe('email.supplier-confirmation')
  })

  it('envía la confirmación al contacto con la clave de idempotencia = id del evento', async () => {
    await expect(handler().handle(event(), timeout.signal)).resolves.toEqual({
      providerMessageId: 'prueba-1',
    })
    const [email] = sender.sent
    expect(email).toMatchObject({
      to: { email: 'ana@proveedor.pe', name: 'Ana Pérez' },
      subject: 'Recibimos tu solicitud ANT-2026-000001',
      idempotencyKey: EVENT_ID,
    })
    expect(email?.text).toContain('Monto solicitado: PEN 8000.00 · 2 facturas')
    // El envío recibe la señal del publicador, no una propia: es la que lo corta al vencer el tope.
    expect(sender.signals[0]).toBe(timeout.signal)
  })

  it('con el tope ya vencido no envía y rechaza con el motivo de la señal', async () => {
    const reason = new Error('tope del handler')
    timeout.abort(reason)
    await expect(handler().handle(event(), timeout.signal)).rejects.toBe(reason)
    expect(sender.sent).toEqual([])
  })

  it('una solicitud que no existe: AGGREGATE_NOT_FOUND y nada enviado', async () => {
    view = null
    expect(await failureCode(handler().handle(event(), timeout.signal))).toBe('AGGREGATE_NOT_FOUND')
    expect(sender.sent).toEqual([])
  })

  it('un evento de otro tipo: PAYLOAD_INVALID', async () => {
    expect(
      await failureCode(handler().handle(event({ eventType: 'otro.evento' }), timeout.signal)),
    ).toBe('PAYLOAD_INVALID')
  })
})

describe('TeamAlertEmailHandler', () => {
  const handler = () =>
    new TeamAlertEmailHandler(reader, sender, {
      teamNotificationEmail: 'equipo@anticipate.local',
      adminBaseUrl: 'https://admin.anticipate.pe',
    })

  it('avisa al equipo con el enlace al admin', async () => {
    expect(handler().handler).toBe('email.team-alert')
    await handler().handle(event({ handler: 'email.team-alert' }), timeout.signal)
    const [email] = sender.sent
    expect(email).toMatchObject({
      to: { email: 'equipo@anticipate.local' },
      subject: 'Nueva solicitud ANT-2026-000001 · SEA',
      idempotencyKey: EVENT_ID,
    })
    expect(email?.html).toContain(`https://admin.anticipate.pe/advance-requests/${REQUEST_ID}`)
    expect(email?.text).toContain('20100070970')
    expect(sender.signals[0]).toBe(timeout.signal)
  })

  it('con el tope ya vencido no envía y rechaza con el motivo de la señal', async () => {
    const reason = new Error('tope del handler')
    timeout.abort(reason)
    await expect(
      handler().handle(event({ handler: 'email.team-alert' }), timeout.signal),
    ).rejects.toBe(reason)
    expect(sender.sent).toEqual([])
  })

  it('una solicitud que no existe: AGGREGATE_NOT_FOUND', async () => {
    view = null
    expect(await failureCode(handler().handle(event(), timeout.signal))).toBe('AGGREGATE_NOT_FOUND')
  })
})
