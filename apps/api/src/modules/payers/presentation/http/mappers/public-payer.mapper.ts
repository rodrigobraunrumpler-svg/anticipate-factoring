import { type PublicPayer, publicPayerSchema } from '@anticipate/shared/payer'
import type { Payer } from '#/modules/payers/domain/types/payer.js'

/** Pagador que no cumple el contrato público: se omite de la respuesta y el controlador lo registra. */
export type RejectedPublicPayer = { id: string; slug: string; issues: string[] }

export type PublicPayerMapping =
  | { ok: true; payer: PublicPayer }
  | { ok: false; rejected: RejectedPublicPayer }

export type PublicPayersMapping = { payers: PublicPayer[]; rejected: RejectedPublicPayer[] }

/**
 * Lleva un `Payer` al contrato público de `@anticipate/shared/payer`. Solo copia los campos públicos
 * (nunca `id`) y los valida con `publicPayerSchema`: lo que sale es exactamente lo que la landing
 * espera, o no sale.
 */
export function toPublicPayer(payer: Payer): PublicPayerMapping {
  const result = publicPayerSchema.safeParse({
    slug: payer.slug,
    ruc: payer.ruc,
    legalName: payer.legalName,
    shortName: payer.shortName,
    advancePercent: payer.advancePercent,
    minTermDays: payer.minTermDays,
    maxInvoices: payer.maxInvoices,
    allowedCurrencies: payer.allowedCurrencies,
    accentColor: payer.accentColor,
    logoUrl: payer.logoUrl,
    texts: payer.texts,
  })
  if (result.success) return { ok: true, payer: result.data }
  return {
    ok: false,
    rejected: {
      id: payer.id,
      slug: payer.slug,
      issues: result.error.issues.map(
        (issue) => `${issue.path.map(String).join('.') || 'pagador'}: ${issue.message}`,
      ),
    },
  }
}

/** Separa los pagadores publicables de los que no cumplen el contrato, sin cambiar el orden. */
export function toPublicPayers(payers: readonly Payer[]): PublicPayersMapping {
  const mapping: PublicPayersMapping = { payers: [], rejected: [] }
  for (const payer of payers) {
    const result = toPublicPayer(payer)
    if (result.ok) {
      mapping.payers.push(result.payer)
    } else {
      mapping.rejected.push(result.rejected)
    }
  }
  return mapping
}
