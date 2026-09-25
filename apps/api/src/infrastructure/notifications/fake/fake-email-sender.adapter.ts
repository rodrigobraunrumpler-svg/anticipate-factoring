import type { EmailSenderPort, OutgoingEmail } from '#/modules/notifications/index.js'

/** Envío en memoria: para tests (`MAIL_TRANSPORT=fake`). La configuración lo rechaza en producción. */
export class FakeEmailSender implements EmailSenderPort {
  readonly sent: OutgoingEmail[] = []
  private failures: Error[] = []

  /** Los próximos `times` envíos fallan con `error`, en orden. */
  failNext(error: Error, times = 1): void {
    for (let i = 0; i < times; i++) this.failures.push(error)
  }

  async send(email: OutgoingEmail): Promise<{ providerMessageId: string | null }> {
    const failure = this.failures.shift()
    if (failure !== undefined) throw failure
    this.sent.push(email)
    return { providerMessageId: `fake-${this.sent.length}` }
  }

  reset(): void {
    this.sent.length = 0
    this.failures = []
  }
}
