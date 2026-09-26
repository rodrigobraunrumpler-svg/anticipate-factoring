import type { FileStoragePort } from '#/common/storage/file-storage.port.js'
import type { StoredFileMaintenancePort } from '../ports/stored-file-maintenance.port.js'

export type PurgeDeletedFilesOptions = {
  readonly batchSize: number
  /** Tope de lotes por pasada: lo que quede sigue en la próxima. */
  readonly maxBatches: number
}

export type PurgeDeletedFilesResult = { purged: number; failed: number }

/**
 * Borrado físico diferido: borra del almacenamiento los objetos de los archivos DELETED cuyo
 * `purge_after` ya venció y marca `purged_at`.
 *
 * Primero se destruye y después se registra: `purged_at` se escribe solo para las claves que el
 * almacenamiento confirmó, así un borrado fallido deja la fila elegible y la próxima pasada lo
 * reintenta. No hace falta reclamar la fila antes: DELETED es un estado final y borrar un objeto que
 * ya no existe no es un error, así que dos réplicas en paralelo solo repiten trabajo.
 *
 * Pide solo filas del bucket del adaptador: S3 responde "borrado" a un DeleteObject de una clave que
 * no existe, así que borrar en este bucket la fila de otro marcaría como purgado un objeto que sigue
 * guardado.
 */
export class PurgeDeletedFilesUseCase {
  constructor(
    private readonly files: Pick<StoredFileMaintenancePort, 'findPurgeable' | 'markPurged'>,
    private readonly storage: Pick<FileStoragePort, 'bucket' | 'deleteQuietly'>,
    private readonly options: PurgeDeletedFilesOptions,
  ) {}

  async execute(): Promise<PurgeDeletedFilesResult> {
    let purged = 0
    let failed = 0
    for (let batch = 0; batch < this.options.maxBatches; batch += 1) {
      const due = await this.files.findPurgeable({
        bucket: this.storage.bucket,
        limit: this.options.batchSize,
      })
      if (due.length === 0) break
      const notDeleted = new Set(await this.storage.deleteQuietly(due.map((file) => file.key)))
      const deletedIds = due.filter((file) => !notDeleted.has(file.key)).map((file) => file.id)
      if (deletedIds.length > 0) purged += await this.files.markPurged(deletedIds)
      failed += due.length - deletedIds.length
      // Un lote incompleto vació la cola. Con fallos se corta: el almacenamiento está rechazando
      // borrados y el lote siguiente volvería a traer las mismas filas.
      if (due.length < this.options.batchSize || deletedIds.length < due.length) break
    }
    return { purged, failed }
  }
}
