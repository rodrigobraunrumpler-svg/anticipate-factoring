import type { Currency } from '@anticipate/shared/money'

/**
 * Condiciones del pagador con las que se evalúa una solicitud. Lo que varía por pagador vive en la
 * base (`payers`), nunca en el código; al crear la solicitud se copian como foto (`applied_*`).
 */
export type PayerConditions = {
  payerId: string
  slug: string
  ruc: string
  shortName: string
  /** 1 a 100 con hasta dos decimales (columna `Decimal(5, 2)`). */
  advancePercent: number
  minTermDays: number
  maxInvoices: number
  allowedCurrencies: Currency[]
}
