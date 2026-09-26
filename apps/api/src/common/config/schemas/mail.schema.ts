import { z } from 'zod'
import { emailAddress, httpUrl, integer, isPublishedHttpsUrl, requiredText } from './env-values.js'
import type { RuntimeEnvironment } from './runtime.schema.js'

export const MAIL_TRANSPORTS = ['smtp', 'brevo', 'fake'] as const
export type MailTransport = (typeof MAIL_TRANSPORTS)[number]

/** Sin parámetros ni fragmento: el aviso al equipo le agrega `/advance-requests/{id}`. */
function isBaseUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.search === '' && url.hash === ''
  } catch {
    // Lo que no es una URL lo informa `httpUrl`, con su propio mensaje.
    return true
  }
}

/**
 * Correo: `smtp` hacia Mailpit en local, `brevo` en staging y producción, `fake` (en memoria) solo en
 * tests. `TEAM_NOTIFICATION_EMAIL` y `ADMIN_BASE_URL` los usa el aviso al equipo. `ADMIN_BASE_URL` es
 * opcional en todo entorno: sin ella el aviso no enlaza a ningún admin (hoy no existe, STACK §7).
 */
export const mailShape = {
  MAIL_TRANSPORT: z.enum(MAIL_TRANSPORTS, { error: 'debe ser smtp, brevo o fake' }),
  SMTP_HOST: requiredText.optional(),
  SMTP_PORT: integer({ fallback: 1025, min: 1, max: 65_535 }),
  BREVO_API_KEY: requiredText.optional(),
  MAIL_FROM_EMAIL: emailAddress,
  MAIL_FROM_NAME: requiredText.default('Anticipate'),
  TEAM_NOTIFICATION_EMAIL: emailAddress,
  ADMIN_BASE_URL: httpUrl
    .refine(isBaseUrl, {
      error:
        'debe ser la URL base del admin, sin parámetros ni fragmento: el correo le agrega /advance-requests/{id}',
    })
    .optional(),
}

const mailSchema = z.object(mailShape)
export type MailEnvironment = z.output<typeof mailSchema>

export function refineMail(
  env: MailEnvironment & Pick<RuntimeEnvironment, 'NODE_ENV'>,
  ctx: z.RefinementCtx,
): void {
  if (env.MAIL_TRANSPORT === 'smtp' && env.SMTP_HOST === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['SMTP_HOST'],
      message: 'es obligatoria con MAIL_TRANSPORT=smtp',
    })
  }
  if (env.MAIL_TRANSPORT === 'brevo' && env.BREVO_API_KEY === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['BREVO_API_KEY'],
      message: 'es obligatoria con MAIL_TRANSPORT=brevo',
    })
  }
  if (env.NODE_ENV === 'production' && env.MAIL_TRANSPORT === 'fake') {
    ctx.addIssue({
      code: 'custom',
      path: ['MAIL_TRANSPORT'],
      message: 'no puede ser fake en producción: los correos se perderían sin aviso',
    })
  }
  if (
    env.NODE_ENV === 'production' &&
    env.ADMIN_BASE_URL !== undefined &&
    !isPublishedHttpsUrl(env.ADMIN_BASE_URL)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['ADMIN_BASE_URL'],
      message:
        'en producción debe ser https y no puede ser localhost ni una IP de loopback: el enlace llega al correo del equipo (https://admin.anticipate.pe)',
    })
  }
}

export function toMailConfig(env: MailEnvironment) {
  return {
    mail: {
      transport: env.MAIL_TRANSPORT,
      smtpHost: env.SMTP_HOST,
      smtpPort: env.SMTP_PORT,
      brevoApiKey: env.BREVO_API_KEY,
      fromEmail: env.MAIL_FROM_EMAIL,
      fromName: env.MAIL_FROM_NAME,
    },
    teamNotificationEmail: env.TEAM_NOTIFICATION_EMAIL,
    /** Sin barra final; `null` sin `ADMIN_BASE_URL`: el aviso al equipo no lleva enlace. */
    adminBaseUrl: env.ADMIN_BASE_URL === undefined ? null : env.ADMIN_BASE_URL.replace(/\/+$/, ''),
  }
}
