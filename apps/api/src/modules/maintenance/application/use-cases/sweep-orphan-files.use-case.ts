import type { StoredFileMaintenancePort } from '../ports/stored-file-maintenance.port.js'

export type SweepOrphanFilesOptions = {
  /** Minutos que un archivo puede seguir en PENDING antes de darlo por huérfano (STORAGE_ORPHAN_GRACE_MINUTES). */
  readonly graceMinutes: number
  readonly batchSize: number
  /** Tope de lotes por pasada: lo que quede sigue en la próxima. */
  readonly maxBatches: number
}

export type SweepOrphanFilesResult = { swept: number }

/**
 * Da de baja los archivos reservados cuya solicitud nunca se confirmó: el proceso murió entre la
 * reserva y la transacción, o `deleteQuietly` no pudo borrar el objeto después de un fallo.
 *
 * Solo cambia la base: los pasa a DELETED con `purge_after = now()` (nunca estuvieron confirmados,
 * así que ninguna restauración de la base los necesita) y el borrado del objeto queda para
 * `PurgeDeletedFilesUseCase`, el único que toca el almacenamiento. La condición PENDING se vuelve a
 * comprobar dentro del UPDATE: si la solicitud se confirmó entre la lectura y la baja, la fila queda
 * ATTACHED y no se cuenta.
 */
export class SweepOrphanFilesUseCase {
  constructor(
    private readonly files: Pick<StoredFileMaintenancePort, 'findOrphans' | 'markDeleted'>,
    private readonly options: SweepOrphanFilesOptions,
  ) {
    // Con cero minutos el barrido daría de baja reservas de envíos que todavía están subiendo.
    if (!Number.isInteger(options.graceMinutes) || options.graceMinutes < 1) {
      throw new RangeError(
        `graceMinutes debe ser un entero mayor que cero: ${options.graceMinutes}`,
      )
    }
  }

  async execute(): Promise<SweepOrphanFilesResult> {
    let swept = 0
    for (let batch = 0; batch < this.options.maxBatches; batch += 1) {
      const orphans = await this.files.findOrphans({
        olderThanMinutes: this.options.graceMinutes,
        limit: this.options.batchSize,
      })
      if (orphans.length === 0) break
      const deleted = await this.files.markDeleted({
        ids: orphans.map((file) => file.id),
        expectedStatus: 'PENDING',
        purgeAfterDays: 0,
      })
      swept += deleted.length
      if (orphans.length < this.options.batchSize) break
    }
    return { swept }
  }
}
