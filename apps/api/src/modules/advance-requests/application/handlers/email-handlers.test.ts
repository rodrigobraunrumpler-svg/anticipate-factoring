import { beforeEach, describe, expect, it } from 'vitest'
import type {
  AdvanceRequestNotificationReaderPort,
  AdvanceRequestNotificationView,
  TeamAlertNotificationView,
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

const TEAM_VIEW: TeamAlertNotificationView = {
  ...VIEW,
  contactMobile: '987654321',
  contactTimeSlot: 'AFTERNOON',
  isLegalRepresentative: false,
  contactJobTitle: 'Jefa de finanzas',
  legalRepresentative: null,
  purpose: null,
  cavaliRegistration: 'NO',
  invoices: [
    {
      seriesNumber: 'F001-123',
      netPendingAmount: '10620.00',
      dueDate: '2026-11-30',
      installmentCount: 2,
      firstDueDate: '2026-10-30',
    },
    {
      seriesNumber: 'F001-124',
      netPendingAmount: '500.00',
      dueDate: '2026-12-15',
      installmentCount: 1,
      firstDueDate: '2026-12-15',
    },
  ],
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
let teamView: TeamAlertNotificationView | null
let sender: RecordingSender
/** El tope del publicador: la señal que recibe `handle`. */
let timeout: AbortController
const teamViewReads: string[] = []
const reader: AdvanceRequestNotificationReaderPort = {
  findById: async () => view,
  findTeamAlertById: async (id) => {
    teamViewReads.push(id)
    return teamView
  },
}

beforeEach(() => {
  view = VIEW
  teamView = TEAM_VIEW
  teamViewReads.length = 0
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
  const handler = (adminBaseUrl: string | null = null) =>
    new TeamAlertEmailHandler(reader, sender, {
      teamNotificationEmail: 'equipo@anticipate.local',
      adminBaseUrl,
    })

  it('avisa al equipo con el contacto, la empresa, el monto y las facturas, leídos al enviar', async () => {
    expect(handler().handler).toBe('email.team-alert')
    await handler().handle(event({ handler: 'email.team-alert' }), timeout.signal)
    expect(teamViewReads).toEqual([REQUEST_ID])
    const [email] = sender.sent
    expect(email).toMatchObject({
      to: { email: 'equipo@anticipate.local' },
      subject: 'Nueva solicitud ANT-2026-000001 · SEA',
      idempotencyKey: EVENT_ID,
    })
    for (const version of [email?.html ?? '', email?.text ?? '']) {
      for (const expected of [
        'Ana Pérez · Jefa de finanzas (no es representante legal)',
        '987 654 321',
        'ana@proveedor.pe',
        'Por la tarde (14 a 18 h)',
        'PROVEEDOR EJEMPLO S.A.C. · RUC 20100070970',
        'PEN 8000.00',
        '¿Facturas registradas en Cavali?: No',
        'F001-123 · PEN 10620.00 neto pendiente · 2 cuotas: la primera vence el 30/10/2026 y la última el 30/11/2026',
        'F001-124 · PEN 500.00 neto pendiente · vence el 15/12/2026',
        '24/09/2026 10:00 (hora de Lima)',
      ]) {
        expect(version).toContain(expected)
      }
    }
    expect(email?.html).toContain('href="tel:+51987654321"')
    expect(sender.signals[0]).toBe(timeout.signal)
  })

  it('sin ADMIN_BASE_URL no enlaza a ningún admin', async () => {
    await handler(null).handle(event({ handler: 'email.team-alert' }), timeout.signal)
    const [email] = sender.sent
    expect(email?.html).not.toContain('admin')
    expect(email?.text).not.toMatch(/admin/i)
  })

  it('con ADMIN_BASE_URL enlaza al detalle de la solicitud en el admin', async () => {
    await handler('https://admin.anticipate.pe').handle(
      event({ handler: 'email.team-alert' }),
      timeout.signal,
    )
    const [email] = sender.sent
    expect(email?.html).toContain(
      `href="https://admin.anticipate.pe/advance-requests/${REQUEST_ID}"`,
    )
    expect(email?.text).toContain(`https://admin.anticipate.pe/advance-requests/${REQUEST_ID}`)
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
    teamView = null
    expect(await failureCode(handler().handle(event(), timeout.signal))).toBe('AGGREGATE_NOT_FOUND')
    expect(sender.sent).toEqual([])
  })

  it('un evento de otro tipo: PAYLOAD_INVALID, sin leer la solicitud', async () => {
    expect(
      await failureCode(handler().handle(event({ eventType: 'otro.evento' }), timeout.signal)),
    ).toBe('PAYLOAD_INVALID')
    expect(teamViewReads).toEqual([])
  })
})
