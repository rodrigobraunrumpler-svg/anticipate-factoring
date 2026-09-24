import { z } from 'zod'
import { VALIDATION_MESSAGES_ES } from '../errors/index.js'
import { dniSchema, rucSchema } from '../identity/index.js'
import { amountSchema } from '../money/index.js'

export const CONTACT_TIME_SLOTS = ['MORNING', 'AFTERNOON', 'ANY'] as const
export const CONTACT_TIME_SLOT_LABELS: Record<(typeof CONTACT_TIME_SLOTS)[number], string> = {
  MORNING: 'Por la mañana (9 a 13 h)',
  AFTERNOON: 'Por la tarde (14 a 18 h)',
  ANY: 'Cualquier horario',
}

export const CAVALI_REGISTRATION = ['YES', 'NO', 'UNKNOWN'] as const

/** Debe coincidir con el tope que anuncia `FORM_MESSAGES.utmTooMany` (lo comprueba form.test.ts). */
const MAX_UTM_KEYS = 10

/**
 * Mensajes del formulario público. Viven en `errors` (`VALIDATION_MESSAGES_ES.advanceRequestForm`)
 * con el resto del texto para personas; esta referencia se conserva para la landing y los tests.
 * Ninguna validación del formulario se queda con el mensaje en inglés por defecto de Zod.
 */
export const FORM_MESSAGES = VALIDATION_MESSAGES_ES.advanceRequestForm

const mobileSchema = z
  .string({ error: FORM_MESSAGES.mobile })
  .trim()
  .regex(/^9\d{8}$/, { error: FORM_MESSAGES.mobile })

// El límite de largo corre antes que el formato: una entrada enorme se rechaza por tamaño sin
// llegar a evaluar la expresión regular de `z.email()` (mitiga backtracking en input adversarial).
const emailSchema = z
  .string({ error: FORM_MESSAGES.email })
  .trim()
  .toLowerCase()
  .max(254, { error: FORM_MESSAGES.emailMax })
  .pipe(z.email({ error: FORM_MESSAGES.email }))

const contactSchema = z
  .object({
    fullName: z
      .string({ error: FORM_MESSAGES.fullNameMin })
      .trim()
      .min(3, { error: FORM_MESSAGES.fullNameMin })
      .max(120, { error: FORM_MESSAGES.fullNameMax }),
    dni: dniSchema,
    mobile: mobileSchema,
    email: emailSchema,
    isLegalRepresentative: z.boolean({ error: FORM_MESSAGES.isLegalRepresentative }),
    jobTitle: z
      .string({ error: FORM_MESSAGES.jobTitleMin })
      .trim()
      .min(2, { error: FORM_MESSAGES.jobTitleMin })
      .max(80, { error: FORM_MESSAGES.jobTitleMax })
      .optional(),
    contactTimeSlot: z.enum(CONTACT_TIME_SLOTS, { error: FORM_MESSAGES.contactTimeSlot }),
  })
  .superRefine((c, ctx) => {
    if (!c.isLegalRepresentative && !c.jobTitle) {
      ctx.addIssue({ code: 'custom', path: ['jobTitle'], message: FORM_MESSAGES.jobTitleRequired })
    }
  })

// Clave acotada a `utm_` + hasta 36 caracteres (40 en total) para no dejar una clave sin tope de
// tamaño; el `error` del propio `z.record` cubre tanto una clave que no matchea como una clave
// válida con un valor inválido, así ningún mensaje de Zod en inglés se cuela en los issues.
const utmKeySchema = z.string().regex(/^utm_[a-z_]{1,36}$/, { error: FORM_MESSAGES.utmKey })
const utmValueSchema = z
  .string({ error: FORM_MESSAGES.utmValueMax })
  .trim()
  .max(200, { error: FORM_MESSAGES.utmValueMax })
const utmSchema = z
  .record(utmKeySchema, utmValueSchema, { error: FORM_MESSAGES.utmKey })
  .refine((utm) => Object.keys(utm).length <= MAX_UTM_KEYS, { error: FORM_MESSAGES.utmTooMany })

/** Campo JSON del `multipart/form-data` de `POST /advance-requests`. Los archivos van aparte. */
export const advanceRequestFormSchema = z.object({
  contact: contactSchema,
  company: z.object({
    ruc: rucSchema,
    legalName: z
      .string({ error: FORM_MESSAGES.legalNameMin })
      .trim()
      .min(3, { error: FORM_MESSAGES.legalNameMin })
      .max(200, { error: FORM_MESSAGES.legalNameMax }),
  }),
  financing: z.object({
    requestedAmount: amountSchema,
    purpose: z
      .string({ error: FORM_MESSAGES.purposeMax })
      .trim()
      .max(500, { error: FORM_MESSAGES.purposeMax })
      .optional(),
  }),
  cavaliRegistration: z.enum(CAVALI_REGISTRATION, { error: FORM_MESSAGES.cavaliRegistration }),
  consents: z.object({
    terms: z.literal(true, { error: FORM_MESSAGES.terms }),
    personalData: z.literal(true, { error: FORM_MESSAGES.personalData }),
    termsVersion: z
      .string({ error: FORM_MESSAGES.termsVersionMin })
      .min(1, { error: FORM_MESSAGES.termsVersionMin })
      .max(20, { error: FORM_MESSAGES.termsVersionMax }),
    privacyVersion: z
      .string({ error: FORM_MESSAGES.privacyVersionMin })
      .min(1, { error: FORM_MESSAGES.privacyVersionMin })
      .max(20, { error: FORM_MESSAGES.privacyVersionMax }),
  }),
  source: z
    .object({
      utm: utmSchema.optional(),
      referrer: z
        .url({ error: FORM_MESSAGES.referrer })
        .max(2000, { error: FORM_MESSAGES.referrerMax })
        .optional(),
    })
    .optional(),
})
export type AdvanceRequestForm = z.infer<typeof advanceRequestFormSchema>
