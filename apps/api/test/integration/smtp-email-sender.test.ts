import { createServer, type Server, type Socket } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

/** Una señal que nadie aborta. */
const live = () => new AbortController().signal

function mailpitSender(timeoutMs = 5_000) {
  const { mail } = testConfig({ MAIL_TRANSPORT: 'smtp' })
  return new SmtpEmailSender({
    host: mail.smtpHost ?? '127.0.0.1',
    port: mail.smtpPort,
    fromEmail: mail.fromEmail,
    fromName: mail.fromName,
    timeoutMs,
  })
}

/** Un servidor SMTP que acepta la conexión y nunca saluda: el envío queda colgado hasta que se corta. */
async function stallingServer(): Promise<{
  server: Server
  port: number
  sockets: Socket[]
  closed: Promise<void>[]
}> {
  const sockets: Socket[] = []
  const closed: Promise<void>[] = []
  const server = createServer((socket) => {
    sockets.push(socket)
    closed.push(new Promise((resolve) => socket.once('close', () => resolve())))
    socket.on('error', () => {})
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('sin puerto')
  return { server, port: address.port, sockets, closed }
}

describe('SmtpEmailSender contra Mailpit', () => {
  beforeEach(clearMailbox)

  let stalling: Awaited<ReturnType<typeof stallingServer>> | undefined
  afterEach(async () => {
    if (stalling === undefined) return
    for (const socket of stalling.sockets) socket.destroy()
    await new Promise((resolve) => stalling?.server.close(resolve))
    stalling = undefined
  })

  it('el correo llega con asunto, HTML, texto, clave de idempotencia y etiqueta', async () => {
    const sender = mailpitSender()
    const idempotencyKey = newId()
    await sender.send({ ...email, idempotencyKey }, live())
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
    const error = await sender
      .send({ ...email, idempotencyKey: newId() }, live())
      .catch((e: unknown) => e)
    sender.close()
    expect(error).toBeInstanceOf(RetryableEmailError)
    expect((error as Error).message).not.toContain('ana@proveedor.pe')
  })

  it('con la señal ya abortada no abre conexión ni envía', async () => {
    const sender = mailpitSender()
    const controller = new AbortController()
    const reason = new Error('tope del handler')
    controller.abort(reason)
    await expect(
      sender.send({ ...email, idempotencyKey: newId() }, controller.signal),
    ).rejects.toBe(reason)
    await sleep(200)
    await expect(findMailsTo('ana@proveedor.pe')).resolves.toEqual([])
  })

  it('abortar corta la conexión en curso: rechaza con el motivo y no queda ningún socket vivo', async () => {
    stalling = await stallingServer()
    const sender = new SmtpEmailSender({
      host: '127.0.0.1',
      port: stalling.port,
      fromEmail: 'solicitudes@anticipate.local',
      fromName: 'Anticipate',
      timeoutMs: 10_000,
    })
    const controller = new AbortController()
    const reason = new Error('tope del handler')
    const sending = sender.send({ ...email, idempotencyKey: newId() }, controller.signal)
    const outcome = sending.then(
      () => 'enviado',
      (error: unknown) => error,
    )
    while (stalling.sockets.length === 0) await sleep(10)
    const abortedAt = performance.now()
    controller.abort(reason)
    await expect(outcome).resolves.toBe(reason)
    expect(performance.now() - abortedAt).toBeLessThan(500)
    await Promise.all(stalling.closed)
  })

  it('el tope propio corta un servidor que no responde aunque la señal no avise', async () => {
    stalling = await stallingServer()
    const sender = new SmtpEmailSender({
      host: '127.0.0.1',
      port: stalling.port,
      fromEmail: 'solicitudes@anticipate.local',
      fromName: 'Anticipate',
      timeoutMs: 300,
    })
    const startedAt = performance.now()
    await expect(sender.send({ ...email, idempotencyKey: newId() }, live())).rejects.toBeInstanceOf(
      RetryableEmailError,
    )
    expect(performance.now() - startedAt).toBeLessThan(2_000)
    await Promise.all(stalling.closed)
  })

  it('después de close() no envía: rechaza como reintentable', async () => {
    const sender = mailpitSender()
    sender.close()
    await expect(sender.send({ ...email, idempotencyKey: newId() }, live())).rejects.toBeInstanceOf(
      RetryableEmailError,
    )
    await sleep(200)
    await expect(findMailsTo('ana@proveedor.pe')).resolves.toEqual([])
  })
})
