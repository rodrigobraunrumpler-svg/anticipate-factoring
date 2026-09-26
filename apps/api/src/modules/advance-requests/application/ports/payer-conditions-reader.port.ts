import type { PayerConditions } from '#/modules/advance-requests/domain/types/payer-conditions.js'

export interface PayerConditionsReaderPort {
  /** El pagador activo con ese slug, o `null` si no existe o está inactivo. */
  findActiveBySlug(slug: string): Promise<PayerConditions | null>
}

export const PAYER_CONDITIONS_READER = Symbol('PAYER_CONDITIONS_READER')
