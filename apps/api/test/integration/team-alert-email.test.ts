import { setTimeout as sleep } from 'node:timers/promises'
import type { AdvanceRequestForm } from '@anticipate/shared/advance-request'
import { Logger } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CAPTCHA_VERIFIER } from '#/common/captcha/index.js'
import { newId } from '#/infrastructure/prisma/id.js'
import { PublishOutboxEventsUseCase } from '#/modules/outbox/index.js'
import {
  ensureLegalDocumentVersions,
  invoiceXml,
  pdf,
  submitAdvanceRequest,
  validForm,
} from '../support/advance-request-fixtures.js'
import { createTestApp } from '../support/app.js'
import { createTestPrisma, truncateAll } from '../support/db.js'
import { createPayer } from '../support/factories.js'
import { FakeCaptchaVerifier } from '../support/fakes.js'
import { findMailsTo, type MailpitMessage, readMail } from '../support/mailpit.js'
import { deletePrefix } from '../support/s3.js'

/**
 * El aviso al equipo de punta a punta: una solicitud real por HTTP, el publicador del outbox real y
 * el correo por SMTP hasta Mailpit. Mailpit es compartido y nunca se vacía: cada test envía a un
 * equipo y a un proveedor con direcciones propias y busca solo esas.
 */

const captcha = new FakeCaptchaVerifier()
const db = createTestPrisma()
let payerId: string

/** Textos del proveedor con todo lo que el HTML tiene que escapar. */
const HOSTILE = {
  fullName: `Ana "La Jefa" O'Brien <b>&</b>`,
  legalName: '<script>alert(1)</script> & Hijos S.A.C.',
  purpose: 'Pago a <proveedores> & "otros"',
}

/** Espera el correo (el envío termina antes, pero Mailpit lo indexa un instante después). */
async function mailTo(address: string): Promise<MailpitMessage> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const [message] = await findMailsTo(address)
    if (message !== undefined) return message
    await sleep(100)
  }
  throw new Error(`No llegó ningún correo a ${address}`)
}

async function withApp(
  env: Record<string, string>,
  run: (app: NestExpressApplication) => Promise<void>,
): Promise<void> {
  const app = await createTestApp({
    env: { MAIL_TRANSPORT: 'smtp', ...env },
    overrides: [[CAPTCHA_VERIFIER, captcha]],
  })
  try {
    await run(app)
  } finally {
    await app.close()
  }
}

/** Registra todo lo que la app escribe con el Logger de Nest mientras corre `run`. */
async function loggedDuring(run: () => Promise<void>): Promise<string> {
  const spies = (['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const).map((level) =>
    vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
  )
  try {
    await run()
    return JSON.stringify(spies.flatMap((spy) => spy.mock.calls))
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
}

function form(contactEmail: string, overrides: Partial<AdvanceRequestForm> = {}) {
  const base = validForm()
  return validForm({
    contact: {
      ...base.contact,
      fullName: HOSTILE.fullName,
      email: contactEmail,
      mobile: '987654321',
      contactTimeSlot: 'AFTERNOON',
    },
    company: { ...base.company, legalName: HOSTILE.legalName },
    financing: { requestedAmount: '8000.00', purpose: HOSTILE.purpose },
    cavaliRegistration: 'NO',
    ...overrides,
  })
}

const TWO_INVOICES = {
  xml: [
    [
      invoiceXml({
        installments: [
          { id: 'Cuota001', amount: '5310.00', dueDate: '2026-10-30' },
          { id: 'Cuota002', amount: '5310.00', dueDate: '2026-11-30' },
        ],
      }),
      'F001-123.xml',
    ],
    [invoiceXml({ seriesNumber: 'F001-124' }), 'F001-124.xml'],
  ] as const,
  pdf: [[pdf(), 'F001-123.pdf']] as const,
}

beforeEach(async () => {
  await truncateAll(db.prisma)
  await ensureLegalDocumentVersions(db.prisma)
  payerId = (await createPayer(db.prisma)).id
  captcha.reset()
})

afterEach(async () => {
  await deletePrefix(`payers/${payerId}/`)
})

afterAll(async () => {
  await db.close()
})

describe('aviso al equipo por SMTP hasta Mailpit', () => {
  it('trae el contacto, la empresa, el monto y las facturas, con el HTML escapado y sin enlace al admin', async () => {
    const id = newId()
    const team = `equipo.${id}@anticipate.local`
    const contactEmail = `ana.${id}@proveedor.pe`

    await withApp({ TEAM_NOTIFICATION_EMAIL: team }, async (app) => {
      const res = await submitAdvanceRequest(app, { form: form(contactEmail), ...TWO_INVOICES })
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      const publicCode: string = res.body.data.publicCode

      // El outbox guarda solo ids: el correo lee los datos de la base al enviarse.
      const events = await db.prisma.outboxEvent.findMany()
      expect(events.map((event) => event.handler).sort()).toEqual([
        'email.supplier-confirmation',
        'email.team-alert',
      ])
      for (const event of events) {
        const payload = JSON.stringify(event.payload)
        for (const personal of [contactEmail, '987654321', 'O\\u0027Brien', 'Ana', 'Hijos']) {
          expect(payload).not.toContain(personal)
        }
      }

      // Nada de lo que la app registra mientras envía lleva los datos del contacto.
      const logged = await loggedDuring(async () => {
        await expect(app.get(PublishOutboxEventsUseCase).execute()).resolves.toMatchObject({
          published: 2,
          deadLettered: 0,
        })
      })
      for (const personal of [contactEmail, '987654321', '987 654 321', 'Brien', 'Hijos']) {
        expect(logged).not.toContain(personal)
      }

      const message = await mailTo(team)
      expect(message.Subject).toBe(`Nueva solicitud ${publicCode} · SEA`)
      expect(message.To.map((to) => to.Address)).toEqual([team])
      const mail = await readMail(message.ID)

      for (const version of [mail.HTML, mail.Text]) {
        for (const expected of [
          publicCode,
          '24/09/2026 10:00 (hora de Lima)',
          'SEA',
          '987 654 321',
          contactEmail,
          'Por la tarde (14 a 18 h)',
          'Representante legal',
          'RUC 20100070970',
          'Monto solicitado: PEN 8000.00',
          '¿Facturas registradas en Cavali?: No',
          'Facturas (2)',
          'F001-123 · PEN 10620.00 neto pendiente · 2 cuotas: la primera vence el 30/10/2026 y la última el 30/11/2026',
          'F001-124 · PEN 10620.00 neto pendiente · vence el 30/11/2026',
        ]) {
          expect(version).toContain(expected)
        }
      }
      // Cada texto del proveedor llega escapado al HTML y tal cual al texto plano.
      expect(mail.HTML).not.toMatch(/<script>|<b>|<proveedores>/)
      expect(mail.HTML).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; Hijos S.A.C.')
      expect(mail.HTML).toContain('&lt;b&gt;&amp;&lt;/b&gt;')
      expect(mail.HTML).toContain('&lt;proveedores&gt; &amp;')
      for (const literal of Object.values(HOSTILE)) expect(mail.Text).toContain(literal)
      expect(mail.HTML).toContain('href="tel:+51987654321"')
      // Sin ADMIN_BASE_URL no hay enlace a un admin que no existe.
      expect(mail.HTML).not.toMatch(/admin/i)
      expect(mail.Text).not.toMatch(/admin/i)

      // La confirmación al proveedor sigue igual: su asunto y ninguno de los datos nuevos.
      const confirmation = await readMail((await mailTo(contactEmail)).ID)
      expect(confirmation.Subject).toBe(`Recibimos tu solicitud ${publicCode}`)
      expect(confirmation.Text).toContain('Monto solicitado: PEN 8000.00 · 2 facturas')
      expect(confirmation.Text).not.toContain('987 654 321')
    })
  })

  it('con ADMIN_BASE_URL enlaza al detalle, y muestra el representante registrado cuando no coincide con el contacto', async () => {
    const id = newId()
    const team = `equipo.${id}@anticipate.local`
    const contactEmail = `ana.${id}@proveedor.pe`
    await withApp(
      { TEAM_NOTIFICATION_EMAIL: team, ADMIN_BASE_URL: 'https://admin.anticipate.pe/' },
      async (app) => {
        // El mismo DNI ya estaba registrado con otro nombre y cargo en una solicitud anterior.
        const supplier = await db.prisma.supplier.create({
          data: { ruc: '20100070970', legalName: 'PROVEEDOR EJEMPLO S.A.C.' },
        })
        await db.prisma.legalRepresentative.create({
          data: {
            supplierId: supplier.id,
            dni: validForm().contact.dni,
            fullName: 'Ana María Pérez Gómez',
            jobTitle: 'Gerente general',
          },
        })
        const res = await submitAdvanceRequest(app, { form: form(contactEmail) })
        expect(res.status, JSON.stringify(res.body)).toBe(201)
        const saved = await db.prisma.advanceRequest.findUniqueOrThrow({
          where: { publicCode: res.body.data.publicCode },
          select: { id: true },
        })
        await app.get(PublishOutboxEventsUseCase).execute()

        const mail = await readMail((await mailTo(team)).ID)
        const adminUrl = `https://admin.anticipate.pe/advance-requests/${saved.id}`
        expect(mail.HTML).toContain(`href="${adminUrl}"`)
        expect(mail.Text).toContain(adminUrl)
        for (const version of [mail.HTML, mail.Text]) {
          expect(version).toContain(
            'Representante legal registrado: Ana María Pérez Gómez (Gerente general)',
          )
        }
      },
    )
  })
})
