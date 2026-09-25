import type { Payer } from '#/modules/payers/domain/types/payer.js'

export interface PayerRepositoryPort {
  /**
   * Pagadores activos ordenados por nombre corto (y por id si empatan). Una fila que no se puede leer
   * como `Payer` se omite y se registra con nivel error: nunca tumba la lista de los demás.
   */
  listActive(): Promise<Payer[]>
}

export const PAYER_REPOSITORY = Symbol('PAYER_REPOSITORY')
