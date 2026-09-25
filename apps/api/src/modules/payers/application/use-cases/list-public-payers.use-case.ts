import type { Payer } from '#/modules/payers/domain/types/payer.js'
import type { PayerRepositoryPort } from '../ports/payer-repository.port.js'

/**
 * Pagadores activos que la landing muestra. Clase sin framework: la cablea `PayersModule` con
 * `useFactory`. Qué campos salen al público lo decide la capa de presentación.
 */
export class ListPublicPayersUseCase {
  constructor(private readonly payers: PayerRepositoryPort) {}

  execute(): Promise<Payer[]> {
    return this.payers.listActive()
  }
}
