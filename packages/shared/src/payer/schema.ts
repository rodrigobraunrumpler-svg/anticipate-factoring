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
  texts: z.record(z.string(), z.string()),
})
export type PublicPayer = z.infer<typeof publicPayerSchema>
