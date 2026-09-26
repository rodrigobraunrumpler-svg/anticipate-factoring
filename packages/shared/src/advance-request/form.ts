import { z } from 'zod'
import { VALIDATION_MESSAGES_ES } from '../errors/index.js'
import { dniSchema, rucSchema } from '../identity/index.js'
import { amountSchema } from '../money/index.js'
import { slugSchema } from '../payer/index.js'
import { isXmlText } from '../text/index.js'

export const CONTACT_TIME_SLOTS = ['MORNING', 'AFTERNOON', 'ANY'] as const
export type ContactTimeSlot = (typeof CONTACT_TIME_SLOTS)[number]
export const CONTACT_TIME_SLOT_LABELS: Readonly<Record<ContactTimeSlot, string>> = {
  MORNING: 'Por la mañana (9 a 13 h)',
  AFTERNOON: 'Por la tarde (14 a 18 h)',
  ANY: 'Cualquier horario',
}

/** ¿Las facturas ya están registradas en Cavali? */
export const CAVALI_REGISTRATION = ['YES', 'NO', 'UNKNOWN'] as const
export type CavaliRegistration = (typeof CAVALI_REGISTRATION)[number]
export const CAVALI_REGISTRATION_LABELS: Readonly<Record<CavaliRegistration, string>> = {
  YES: 'Sí',
  NO: 'No',
  UNKNOWN: 'No sé',
}

/*
 * Todo texto libre del formulario termina en una columna de texto (o en `utm`, que es jsonb) de
 * `advance_requests`, `suppliers`, `legal_representatives` o `consents`, o se compara con una
 * (`legal_document_versions.version`). `isXmlText` es la gemela del tipo de esas columnas: PostgreSQL
 * no guarda U+0000 (22021 en texto, 22P05 en jsonb) y un sustituto suelto se guardaría cambiado por
 * U+FFFD (en jsonb, 22P02). Sin esto, un envío que pasa el formulario haría fallar el INSERT (503 en
 * cada reintento) o la lectura de las versiones legales (500), en vez de responder 400 con el campo.
 * Los topes de largo ya cuentan puntos de código, como `char_length` y el `VARCHAR` de cada columna.
 * Lo fija un test `(f)` de `database-structure.test.ts` contra las columnas reales.
 */

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
  .object(
    {
      fullName: z
        .string({ error: FORM_MESSAGES.fullNameMin })
        .trim()
        .min(3, { error: FORM_MESSAGES.fullNameMin })
        .max(120, { error: FORM_MESSAGES.fullNameMax })
        .refine(isXmlText, { error: FORM_MESSAGES.fullName }),
      dni: dniSchema,
      mobile: mobileSchema,
      email: emailSchema,
      isLegalRepresentative: z.boolean({ error: FORM_MESSAGES.isLegalRepresentative }),
      jobTitle: z
        .string({ error: FORM_MESSAGES.jobTitleMin })
        .trim()
        .min(2, { error: FORM_MESSAGES.jobTitleMin })
        .max(80, { error: FORM_MESSAGES.jobTitleMax })
        .refine(isXmlText, { error: FORM_MESSAGES.jobTitle })
        .optional(),
      contactTimeSlot: z.enum(CONTACT_TIME_SLOTS, { error: FORM_MESSAGES.contactTimeSlot }),
    },
    { error: FORM_MESSAGES.contact },
  )
  .superRefine((c, ctx) => {
    if (!c.isLegalRepresentative && !c.jobTitle) {
      ctx.addIssue({ code: 'custom', path: ['jobTitle'], message: FORM_MESSAGES.jobTitleRequired })
    }
  })

// Clave acotada a `utm_` + hasta 36 caracteres (40 en total) para no dejar una clave sin tope de
// tamaño. Cada pieza trae su mensaje: el `error` del `z.record` cubre que `utm` no sea un objeto
// (`invalid_type`) y la clave inválida (`invalid_key`, con el issue de la clave anidado), y los de
// la clave y del valor cubren sus propios issues; así ningún mensaje en inglés de Zod se cuela.
const utmKeySchema = z
  .string({ error: FORM_MESSAGES.utmKey })
  .regex(/^utm_[a-z_]{1,36}$/, { error: FORM_MESSAGES.utmKey })
const utmValueSchema = z
  .string({ error: FORM_MESSAGES.utmValueMax })
  .trim()
  .max(200, { error: FORM_MESSAGES.utmValueMax })
  .refine(isXmlText, { error: FORM_MESSAGES.utmValue })
const utmSchema = z
  .record(utmKeySchema, utmValueSchema, {
    error: (issue) => (issue.code === 'invalid_type' ? FORM_MESSAGES.utm : FORM_MESSAGES.utmKey),
  })
  .refine((utm) => Object.keys(utm).length <= MAX_UTM_KEYS, { error: FORM_MESSAGES.utmTooMany })

// Solo http o https: `z.url()` acepta `javascript:` y `data:`, que el admin podría terminar
// mostrando como enlace. El tope de largo corre antes que el formato, como en el correo.
//
// El referrer es un dato de analítica que pone el navegador, no el proveedor: no lo ve ni puede
// corregirlo. Chrome en Android informa `android-app://…` cuando el enlace se abre desde la app de
// Google, así que un referrer que no pasa se descarta (queda `undefined`) en vez de invalidar el
// formulario completo. `.catch` solo cambia qué pasa con un referrer que no pasa, no qué se guarda:
// nunca un `javascript:`, un `data:` ni otro esquema, ni más de 2000 caracteres. Los mensajes en
// español del esquema interno se quedan: si alguien quita el `.catch`, el rechazo sigue en español.
const referrerSchema = z
  .string({ error: FORM_MESSAGES.referrer })
  .max(2000, { error: FORM_MESSAGES.referrerMax })
  .pipe(
    z
      .httpUrl({ error: FORM_MESSAGES.referrer })
      .refine(isXmlText, { error: FORM_MESSAGES.referrer }),
  )
  .optional()
  .catch(undefined)

/**
 * Campo JSON del `multipart/form-data` de `POST /advance-requests`. Los archivos van aparte. Cada
 * `z.object` trae su `error`: un bloque que falta o no es un objeto (lo que la landing nunca envía,
 * pero sí una llamada directa a la API) se informa en español, no con el inglés por defecto de Zod.
 */
export const advanceRequestFormSchema = z.object(
  {
    /**
     * Pagador de la landing desde la que se envía (`/sea` → `sea`). La API busca con este slug al
     * pagador activo y arma con su configuración el `ValidationContext` de las facturas (RUC,
     * porcentaje de adelanto, plazo mínimo, máximo de facturas y monedas); un slug desconocido o
     * inactivo se rechaza antes de leer los archivos.
     */
    payerSlug: slugSchema,
    contact: contactSchema,
    company: z.object(
      {
        ruc: rucSchema,
        legalName: z
          .string({ error: FORM_MESSAGES.legalNameMin })
          .trim()
          .min(3, { error: FORM_MESSAGES.legalNameMin })
          .max(200, { error: FORM_MESSAGES.legalNameMax })
          .refine(isXmlText, { error: FORM_MESSAGES.legalName }),
      },
      { error: FORM_MESSAGES.company },
    ),
    financing: z.object(
      {
        requestedAmount: amountSchema,
        purpose: z
          .string({ error: FORM_MESSAGES.purposeMax })
          .trim()
          .max(500, { error: FORM_MESSAGES.purposeMax })
          .refine(isXmlText, { error: FORM_MESSAGES.purpose })
          .optional(),
      },
      { error: FORM_MESSAGES.financing },
    ),
    cavaliRegistration: z.enum(CAVALI_REGISTRATION, { error: FORM_MESSAGES.cavaliRegistration }),
    consents: z.object(
      {
        terms: z.literal(true, { error: FORM_MESSAGES.terms }),
        // Recortadas como todo texto del formulario: una versión en blanco es que falta (gemela de
        // `btrim(document_version) <> ''` en consents), nunca un INSERT que falle.
        personalData: z.literal(true, { error: FORM_MESSAGES.personalData }),
        termsVersion: z
          .string({ error: FORM_MESSAGES.termsVersionMin })
          .trim()
          .min(1, { error: FORM_MESSAGES.termsVersionMin })
          .max(20, { error: FORM_MESSAGES.termsVersionMax })
          .refine(isXmlText, { error: FORM_MESSAGES.termsVersion }),
        privacyVersion: z
          .string({ error: FORM_MESSAGES.privacyVersionMin })
          .trim()
          .min(1, { error: FORM_MESSAGES.privacyVersionMin })
          .max(20, { error: FORM_MESSAGES.privacyVersionMax })
          .refine(isXmlText, { error: FORM_MESSAGES.privacyVersion }),
      },
      { error: FORM_MESSAGES.consents },
    ),
    source: z
      .object(
        {
          utm: utmSchema.optional(),
          referrer: referrerSchema,
        },
        { error: FORM_MESSAGES.source },
      )
      .optional(),
  },
  { error: FORM_MESSAGES.form },
)
export type AdvanceRequestForm = z.infer<typeof advanceRequestFormSchema>
