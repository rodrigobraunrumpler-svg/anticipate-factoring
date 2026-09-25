import { describe, expect, it } from 'vitest'
import { testConfig } from '../../../test/support/config.js'
import { BrevoEmailSender } from './brevo/brevo-email-sender.adapter.js'
import { FakeEmailSender } from './fake/fake-email-sender.adapter.js'
import { createEmailSender } from './notifications-infrastructure.module.js'
import { SmtpEmailSender } from './smtp/smtp-email-sender.adapter.js'

describe('createEmailSender', () => {
  it('elige el adaptador según MAIL_TRANSPORT', () => {
    expect(createEmailSender(testConfig({ MAIL_TRANSPORT: 'fake' }))).toBeInstanceOf(
      FakeEmailSender,
    )
    expect(createEmailSender(testConfig({ MAIL_TRANSPORT: 'smtp' }))).toBeInstanceOf(
      SmtpEmailSender,
    )
    expect(
      createEmailSender(testConfig({ MAIL_TRANSPORT: 'brevo', BREVO_API_KEY: 'xkeysib-test' })),
    ).toBeInstanceOf(BrevoEmailSender)
  })
})
