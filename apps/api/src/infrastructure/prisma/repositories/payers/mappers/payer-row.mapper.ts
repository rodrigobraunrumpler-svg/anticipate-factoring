import type { Prisma } from '#/infrastructure/prisma/generated/client.js'
import type { Payer } from '#/modules/payers/index.js'

/** Proyección de GET /api/v1/payers: solo lo que necesita `Payer` (nunca `active` ni fechas). */
export const PAYER_ROW_SELECT = {
  id: true,
  slug: true,
  ruc: true,
  legalName: true,
  shortName: true,
  advancePercent: true,
  minTermDays: true,
  maxInvoices: true,
  allowedCurrencies: true,
  accentColor: true,
  logoUrl: true,
  texts: true,
} satisfies Prisma.PayerSelect

export type PayerRow = Prisma.PayerGetPayload<{ select: typeof PAYER_ROW_SELECT }>

export type PayerRowMapping = { ok: true; payer: Payer } | { ok: false; reason: string }

/**
 * Convierte una fila de `payers` en `Payer`. `advance_percent` es `Decimal(5, 2)` y sale como número
 * con dos decimales; `texts` es JSON y debe ser un objeto plano de textos. Si no lo es, la fila no se
 * puede representar y se devuelve el motivo en vez de lanzar: el repositorio la omite y la registra.
 */
export function toPayer(row: PayerRow): PayerRowMapping {
  const texts = toPayerTexts(row.texts)
  if (!texts.ok) return { ok: false, reason: texts.reason }
  return {
    ok: true,
    payer: {
      id: row.id,
      slug: row.slug,
      ruc: row.ruc,
      legalName: row.legalName,
      shortName: row.shortName,
      advancePercent: Number(row.advancePercent.toFixed(2)),
      minTermDays: row.minTermDays,
      maxInvoices: row.maxInvoices,
      allowedCurrencies: [...row.allowedCurrencies],
      accentColor: row.accentColor,
      logoUrl: row.logoUrl,
      texts: texts.value,
    },
  }
}

type TextsMapping = { ok: true; value: Record<string, string> } | { ok: false; reason: string }

function toPayerTexts(value: Prisma.JsonValue): TextsMapping {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'texts no es un objeto JSON' }
  }
  const entries = Object.entries(value)
  const invalid = entries.find(([, text]) => typeof text !== 'string')
  if (invalid) return { ok: false, reason: `el texto «${invalid[0]}» no es una cadena` }
  // fromEntries define propiedades propias: una clave «__proto__» no cambia el prototipo.
  return { ok: true, value: Object.fromEntries(entries) as Record<string, string> }
}
