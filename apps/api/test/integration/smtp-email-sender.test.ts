import { beforeEach, describe, expect, it } from 'vitest'
import { SmtpEmailSender } from '#/infrastructure/notifications/index.js'
import { newId } from '#/infrastructure/prisma/id.js'
import { RetryableEmailError } from '#/modules/notifications/index.js'
import { testConfig } from '../support/config.js'
import { clearMailbox, findMailsTo, readMail, readMailHeaders } from '../support/mailpit.js'

const email = {
  to: { email: 'ana@proveedor.pe', name: 'Ana Pérez' },
  subject: 'Recibimos tu solicitud ANT-2026-000001',
  html: '<p>Hola, Ana</p>',
  text: 'Hola, Ana',
  tags: ['email.supplier-confirmation'],
}

describe('SmtpEmailSender contra Mailpit', () => {
  beforeEach(clearMailbox)

  it('el correo llega con asunto, HTML, texto, clave de idempotencia y etiqueta', async () => {
    const { mail } = testConfig({ MAIL_TRANSPORT: 'smtp' })
    const sender = new SmtpEmailSender({
      host: mail.smtpHost ?? '127.0.0.1',
      port: mail.smtpPort,
      fromEmail: mail.fromEmail,
      fromName: mail.fromName,
      timeoutMs: 5_000,
    })
    const idempotencyKey = newId()
    await sender.send({ ...email, idempotencyKey })
    sender.close()

    const [message] = await findMailsTo('ana@proveedor.pe')
    expect(message?.Subject).toBe('Recibimos tu solicitud ANT-2026-000001')
    expect(message?.Tags).toEqual(['email.supplier-confirmation'])
    const full = await readMail(message?.ID ?? '')
    expect(full.HTML).toContain('Hola, Ana')
    expect(full.Text).toContain('Hola, Ana')
    expect((await readMailHeaders(message?.ID ?? ''))['X-Idempotency-Key']).toEqual([
      idempotencyKey,
    ])
  })

  it('sin servidor es reintentable y el error no nombra al destinatario', async () => {
    const sender = new SmtpEmailSender({
      host: '127.0.0.1',
      port: 1,
      fromEmail: 'solicitudes@anticipate.local',
      fromName: 'Anticipate',
      timeoutMs: 2_000,
    })
    const error = await sender.send({ ...email, idempotencyKey: newId() }).catch((e: unknown) => e)
    sender.close()
    expect(error).toBeInstanceOf(RetryableEmailError)
    expect((error as Error).message).not.toContain('ana@proveedor.pe')
  })
})
