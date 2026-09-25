import type { Currency } from '@anticipate/shared/money'

/**
 * Pagador del programa de adelanto tal como lo guarda la plataforma. Sus condiciones (porcentaje,
 * plazo mínimo, máximo de facturas y monedas) viven en la base y se cambian sin desplegar. `id` es
 * interno: la lista pública nunca lo expone.
 */
export type Payer = {
  id: string
  slug: string
  ruc: string
  legalName: string
  shortName: string
  advancePercent: number
  minTermDays: number
  maxInvoices: number
  allowedCurrencies: Currency[]
  accentColor: string
  logoUrl: string | null
  texts: Record<string, string>
}
