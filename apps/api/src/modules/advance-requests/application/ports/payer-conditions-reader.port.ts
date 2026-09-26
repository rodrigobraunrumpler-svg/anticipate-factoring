import type { RepositoryCallOptions } from '#/modules/advance-requests/application/ports/advance-request-repository.port.js'
import type { PayerConditions } from '#/modules/advance-requests/domain/types/payer-conditions.js'

export interface PayerConditionsReaderPort {
  /**
   * El pagador activo con ese slug, o `null` si no existe o está inactivo. Con `signal` cancelada
   * rechaza en el acto con su motivo.
   */
  findActiveBySlug(slug: string, options?: RepositoryCallOptions): Promise<PayerConditions | null>
}

export const PAYER_CONDITIONS_READER = Symbol('PAYER_CONDITIONS_READER')
