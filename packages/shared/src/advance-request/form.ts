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

const MAX_UTM_KEYS = 10

// `advance-request` no puede importar de `errors` (tabla de dependencias): estos mensajes son
// propios del formulario público, no los de `messages.es.ts`. Centralizados aquí para que
// ninguna validación se quede con el mensaje en inglés por defecto de Zod (zodResolver los
// mostraría tal cual en un formulario en español).
export const FORM_MESSAGES = {
  fullNameMin: 'Escribe tu nombre completo.',
  fullNameMax: 'El nombre no puede tener más de 120 caracteres.',
  mobile: 'El celular debe tener 9 dígitos y empezar con 9.',
  emailMax: 'El correo no puede tener más de 254 caracteres.',
  email: 'El correo no es válido.',
  jobTitleMin: 'El cargo debe tener al menos 2 caracteres.',
  jobTitleMax: 'El cargo no puede tener más de 80 caracteres.',
  jobTitleRequired: 'Indica tu cargo en la empresa.',
  contactTimeSlot: 'Selecciona un horario de contacto válido.',
  legalNameMin: 'La razón social debe tener al menos 3 caracteres.',
  legalNameMax: 'La razón social no puede tener más de 200 caracteres.',
  purposeMax: 'El destino del financiamiento no puede tener más de 500 caracteres.',
  cavaliRegistration: 'Selecciona una opción válida de registro en CAVALI.',
  terms: 'Debes aceptar los términos y condiciones.',
  personalData: 'Debes autorizar el tratamiento de tus datos personales.',
  termsVersionMin: 'Falta la versión de los términos y condiciones.',
  termsVersionMax: 'La versión de los términos y condiciones no es válida.',
  privacyVersionMin: 'Falta la versión de la política de privacidad.',
  privacyVersionMax: 'La versión de la política de privacidad no es válida.',
  utmKey: 'Los parámetros de origen solo pueden usar claves utm_* de hasta 40 caracteres.',
  utmValueMax: 'El valor del parámetro de origen es demasiado largo.',
  utmTooMany: `Hay demasiados parámetros de origen (máximo ${MAX_UTM_KEYS}).`,
  referrer: 'La URL de referencia no es válida.',
  referrerMax: 'La URL de referencia no puede tener más de 2000 caracteres.',
} as const

const mobileSchema = z
  .string()
  .trim()
  .regex(/^9\d{8}$/, { error: FORM_MESSAGES.mobile })

// El límite de largo corre antes que el formato: una entrada enorme se rechaza por tamaño sin
// llegar a evaluar la expresión regular de `z.email()` (mitiga backtracking en input adversarial).
const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, { error: FORM_MESSAGES.emailMax })
  .pipe(z.email({ error: FORM_MESSAGES.email }))

const contactSchema = z
  .object({
    fullName: z
      .string()
      .trim()
      .min(3, { error: FORM_MESSAGES.fullNameMin })
      .max(120, { error: FORM_MESSAGES.fullNameMax }),
    dni: dniSchema,
    mobile: mobileSchema,
    email: emailSchema,
    isLegalRepresentative: z.boolean(),
    jobTitle: z
      .string()
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
const utmValueSchema = z.string().trim().max(200, { error: FORM_MESSAGES.utmValueMax })
const utmSchema = z
  .record(utmKeySchema, utmValueSchema, { error: FORM_MESSAGES.utmKey })
  .refine((utm) => Object.keys(utm).length <= MAX_UTM_KEYS, { error: FORM_MESSAGES.utmTooMany })

/** Campo JSON del `multipart/form-data` de `POST /advance-requests`. Los archivos van aparte. */
export const advanceRequestFormSchema = z.object({
  contact: contactSchema,
  company: z.object({
    ruc: rucSchema,
    legalName: z
      .string()
      .trim()
      .min(3, { error: FORM_MESSAGES.legalNameMin })
      .max(200, { error: FORM_MESSAGES.legalNameMax }),
  }),
  financing: z.object({
    requestedAmount: amountSchema,
    purpose: z.string().trim().max(500, { error: FORM_MESSAGES.purposeMax }).optional(),
  }),
  cavaliRegistration: z.enum(CAVALI_REGISTRATION, { error: FORM_MESSAGES.cavaliRegistration }),
  consents: z.object({
    terms: z.literal(true, { error: FORM_MESSAGES.terms }),
    personalData: z.literal(true, { error: FORM_MESSAGES.personalData }),
    termsVersion: z
      .string()
      .min(1, { error: FORM_MESSAGES.termsVersionMin })
      .max(20, { error: FORM_MESSAGES.termsVersionMax }),
    privacyVersion: z
      .string()
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
