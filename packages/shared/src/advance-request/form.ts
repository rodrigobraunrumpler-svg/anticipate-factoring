import { z } from 'zod'
import { dniSchema, rucSchema } from '../identity/index.js'
import { amountSchema } from '../money/index.js'

export const CONTACT_TIME_SLOTS = ['MORNING', 'AFTERNOON', 'ANY'] as const
export const CONTACT_TIME_SLOT_LABELS: Record<(typeof CONTACT_TIME_SLOTS)[number], string> = {
  MORNING: 'Por la mañana (9 a 13 h)',
  AFTERNOON: 'Por la tarde (14 a 18 h)',
  ANY: 'Cualquier horario',
}

export const CAVALI_REGISTRATION = ['YES', 'NO', 'UNKNOWN'] as const

const mobileSchema = z
  .string()
  .trim()
  .regex(/^9\d{8}$/, { error: 'El celular debe tener 9 dígitos y empezar con 9.' })

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: 'El correo no es válido.' }))

const contactSchema = z
  .object({
    fullName: z.string().trim().min(3, 'Escribe tu nombre completo.').max(120),
    dni: dniSchema,
    mobile: mobileSchema,
    email: emailSchema,
    isLegalRepresentative: z.boolean(),
    jobTitle: z.string().trim().min(2).max(80).optional(),
    contactTimeSlot: z.enum(CONTACT_TIME_SLOTS),
  })
  .superRefine((c, ctx) => {
    if (!c.isLegalRepresentative && !c.jobTitle) {
      ctx.addIssue({
        code: 'custom',
        path: ['jobTitle'],
        message: 'Indica tu cargo en la empresa.',
      })
    }
  })

const utmSchema = z.record(z.string().regex(/^utm_[a-z_]+$/), z.string().trim().max(200))

/** Campo JSON del `multipart/form-data` de `POST /advance-requests`. Los archivos van aparte. */
export const advanceRequestFormSchema = z.object({
  contact: contactSchema,
  company: z.object({
    ruc: rucSchema,
    legalName: z.string().trim().min(3).max(200),
  }),
  financing: z.object({
    requestedAmount: amountSchema,
    purpose: z.string().trim().max(500).optional(),
  }),
  cavaliRegistration: z.enum(CAVALI_REGISTRATION),
  consents: z.object({
    terms: z.literal(true, { error: 'Debes aceptar los términos y condiciones.' }),
    personalData: z.literal(true, {
      error: 'Debes autorizar el tratamiento de tus datos personales.',
    }),
    termsVersion: z.string().min(1),
    privacyVersion: z.string().min(1),
  }),
  source: z
    .object({
      utm: utmSchema.optional(),
      referrer: z.url().max(2000).optional(),
    })
    .optional(),
})
export type AdvanceRequestForm = z.infer<typeof advanceRequestFormSchema>
