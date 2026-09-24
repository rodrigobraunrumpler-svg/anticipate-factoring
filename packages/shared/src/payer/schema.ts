import { z } from 'zod'
import { VALIDATION_MESSAGES_ES } from '../errors/index.js'
import { rucSchema } from '../identity/index.js'
import { CURRENCIES } from '../money/index.js'

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

const M = VALIDATION_MESSAGES_ES.payer

export function isHexColor(value: string): boolean {
  return HEX_COLOR.test(value)
}

export const slugSchema = z
  .string({ error: M.slug })
  .max(60, { error: M.slugMax })
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { error: M.slug })

const MAX_TEXT_KEYS = 30

// Clave acotada a camelCase de hasta 40 caracteres y valor acotado a 2000 caracteres para no dejar
// un campo sin tope de tamaño. El `error` del propio `z.record` (forma de 3 argumentos) cubre que
// `texts` no sea un objeto y la clave inválida, y el de la clave y el del valor cubren sus propios
// issues, así ningún mensaje de Zod en inglés se cuela en los issues.
const textKeySchema = z
  .string({ error: M.textKey })
  .regex(/^[a-z][a-zA-Z0-9]{0,39}$/, { error: M.textKey })
const textValueSchema = z.string({ error: M.texts }).trim().max(2000, { error: M.textValueMax })
const textsSchema = z
  .record(textKeySchema, textValueSchema, {
    error: (issue) => (issue.code === 'invalid_type' ? M.texts : M.textKey),
  })
  .refine((texts) => Object.keys(texts).length <= MAX_TEXT_KEYS, { error: M.textsTooMany })

/** Porcentaje de adelanto: de 1 a 100 con hasta dos decimales (80, 33.33). */
const advancePercentSchema = z
  .number({ error: M.advancePercent })
  .min(1, { error: M.advancePercent })
  .max(100, { error: M.advancePercent })
  .multipleOf(0.01, { error: M.advancePercent })

/** Lo que la landing recibe de `GET /payers`: solo campos públicos (STACK §8). */
export const publicPayerSchema = z.object(
  {
    slug: slugSchema,
    ruc: rucSchema,
    legalName: z
      .string({ error: M.legalNameMin })
      .trim()
      .min(3, { error: M.legalNameMin })
      .max(200, { error: M.legalNameMax }),
    shortName: z
      .string({ error: M.shortNameMin })
      .trim()
      .min(2, { error: M.shortNameMin })
      .max(40, { error: M.shortNameMax }),
    advancePercent: advancePercentSchema,
    minTermDays: z
      .number({ error: M.minTermDays })
      .int({ error: M.minTermDays })
      .min(0, { error: M.minTermDays }),
    maxInvoices: z
      .number({ error: M.maxInvoices })
      .int({ error: M.maxInvoices })
      .min(1, { error: M.maxInvoices }),
    allowedCurrencies: z
      .array(z.enum(CURRENCIES, { error: M.allowedCurrencies }), { error: M.allowedCurrencies })
      .min(1, { error: M.allowedCurrencies }),
    accentColor: z.string({ error: M.accentColor }).refine(isHexColor, { error: M.accentColor }),
    // Solo http o https: `z.url()` acepta `javascript:` y `data:`, y la landing pinta este valor.
    logoUrl: z.httpUrl({ error: M.logoUrl }).nullable(),
    texts: textsSchema,
  },
  { error: M.publicPayer },
)
export type PublicPayer = z.infer<typeof publicPayerSchema>
