export {
  BrevoEmailSender,
  type BrevoEmailSenderOptions,
} from './brevo/brevo-email-sender.adapter.js'
export { FakeEmailSender } from './fake/fake-email-sender.adapter.js'
export {
  createEmailSender,
  NotificationsInfrastructureModule,
} from './notifications-infrastructure.module.js'
export { SmtpEmailSender, type SmtpEmailSenderOptions } from './smtp/smtp-email-sender.adapter.js'
