import { z } from 'zod'
import { rucSchema } from '../identity/index.js'
import { CURRENCIES } from '../money/index.js'

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

export function isHexColor(value: string): boolean {
  return HEX_COLOR.test(value)
}

export const slugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    error: 'El slug solo admite minúsculas, números y guiones.',
  })
  .max(60)

const MAX_TEXT_KEYS = 30
const TEXT_KEY_MESSAGE =
  'La clave del texto debe ser camelCase (iniciar en minúscula) y tener como máximo 40 caracteres.'

// Clave acotada a camelCase de hasta 40 caracteres y valor acotado a 2000 caracteres para no dejar
// un campo sin tope de tamaño; el `error` del propio `z.record` (forma de 3 argumentos) cubre la
// clave inválida, así ningún mensaje de Zod en inglés se cuela en los issues.
const textKeySchema = z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/, { error: TEXT_KEY_MESSAGE })
const textValueSchema = z
  .string()
  .trim()
  .max(2000, { error: 'El texto no debe superar los 2000 caracteres.' })
const textsSchema = z
  .record(textKeySchema, textValueSchema, { error: TEXT_KEY_MESSAGE })
  .refine((texts) => Object.keys(texts).length <= MAX_TEXT_KEYS, {
    error: `Hay demasiados textos (máximo ${MAX_TEXT_KEYS}).`,
  })

/** Lo que la landing recibe de `GET /payers`: solo campos públicos (STACK §8). */
export const publicPayerSchema = z.object({
  slug: slugSchema,
  ruc: rucSchema,
  legalName: z.string().trim().min(3).max(200),
  shortName: z.string().trim().min(2).max(40),
  advancePercent: z.number().min(1).max(100).multipleOf(0.01),
  minTermDays: z.number().int().min(0),
  maxInvoices: z.number().int().min(1),
  allowedCurrencies: z.array(z.enum(CURRENCIES)).min(1),
  accentColor: z
    .string()
    .refine(isHexColor, { error: 'El color debe ser hexadecimal, por ejemplo #0E7C86.' }),
  logoUrl: z.url().nullable(),
  texts: textsSchema,
})
export type PublicPayer = z.infer<typeof publicPayerSchema>
