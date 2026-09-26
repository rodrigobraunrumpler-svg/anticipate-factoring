import type { PayerRepositoryPort } from '#/modules/payers/application/ports/payer-repository.port.js'
import type { IntakeCapacityMonitor } from '#/modules/payers/application/services/intake-capacity-monitor.js'
import type { Payer } from '#/modules/payers/domain/types/payer.js'

/**
 * Pagadores activos que la landing muestra. Clase sin framework: la cablea `PayersModule` con
 * `useFactory`. Qué campos salen al público lo decide la capa de presentación. Cada lista servida
 * pasa por `IntakeCapacityMonitor`: el máximo de facturas de un pagador cambia en la base sin
 * desplegar, y un máximo que los topes de subida no alcanzan deja un log de error.
 */
export class ListPublicPayersUseCase {
  constructor(
    private readonly payers: PayerRepositoryPort,
    private readonly capacity: Pick<IntakeCapacityMonitor, 'review'>,
  ) {}

  async execute(): Promise<Payer[]> {
    const payers = await this.payers.listActive()
    this.capacity.review(payers)
    return payers
  }
}
