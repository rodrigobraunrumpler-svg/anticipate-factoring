import type { IsoDate } from '@anticipate/shared/dates'
import { isValidRuc } from '@anticipate/shared/identity'
import type { ValidationContext } from '@anticipate/shared/invoice'
import { isCurrency } from '@anticipate/shared/money'
import type { PayerConditions } from '../types/payer-conditions.js'

/** El mismo tope que el CHECK de `payers.max_invoices` y el de `advance_requests.invoice_count`. */
const MAX_INVOICES_PER_REQUEST = 100

/**
 * Contexto de las reglas de factura a partir del pagador guardado. `validateInvoices` exige un
 * contexto válido, así que se comprueba aquí: un pagador mal configurado es un error de la
 * plataforma (se registra y responde 500), nunca un problema del proveedor. La base ya lo impide con
 * sus CHECK; esta comprobación cubre un cambio de esquema que las pierda.
 */
export function buildValidationContext(
  payer: PayerConditions,
  supplierRuc: string,
  today: IsoDate,
): ValidationContext {
  const misconfigured = (detail: string) => new RangeError(`Pagador ${payer.slug}: ${detail}`)
  if (!isValidRuc(payer.ruc)) throw misconfigured(`ruc inválido (${payer.ruc})`)
  if (
    !Number.isFinite(payer.advancePercent) ||
    payer.advancePercent < 1 ||
    payer.advancePercent > 100
  ) {
    throw misconfigured(`advancePercent fuera de rango (${payer.advancePercent})`)
  }
  if (!Number.isInteger(payer.minTermDays) || payer.minTermDays < 0) {
    throw misconfigured(`minTermDays inválido (${payer.minTermDays})`)
  }
  if (
    !Number.isInteger(payer.maxInvoices) ||
    payer.maxInvoices < 1 ||
    payer.maxInvoices > MAX_INVOICES_PER_REQUEST
  ) {
    throw misconfigured(`maxInvoices fuera de rango (${payer.maxInvoices})`)
  }
  if (payer.allowedCurrencies.length === 0 || !payer.allowedCurrencies.every(isCurrency)) {
    throw misconfigured(`allowedCurrencies inválido (${payer.allowedCurrencies.join(', ')})`)
  }
  return {
    payerRuc: payer.ruc,
    payerName: payer.shortName,
    supplierRuc,
    advancePercent: payer.advancePercent,
    minTermDays: payer.minTermDays,
    maxInvoices: payer.maxInvoices,
    allowedCurrencies: [...payer.allowedCurrencies],
    today,
  }
}
