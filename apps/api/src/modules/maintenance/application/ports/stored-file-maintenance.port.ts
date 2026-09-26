/** Archivo que sigue en PENDING después de la gracia: su solicitud nunca se confirmó. */
export type OrphanFile = { id: string; key: string; createdAt: Date }

/** Archivo en DELETED cuyo borrado físico ya venció y todavía no se hizo. */
export type PurgeableFile = { id: string; key: string }

/** Estados desde los que la base deja pasar un archivo a DELETED (`stored_files_guard`). */
export type DeletableFileStatus = 'PENDING' | 'ATTACHED'

/**
 * Ciclo de vida de `stored_files` visto desde el mantenimiento. Todos los tiempos los pone la base
 * con `now()`: el reloj inyectable es solo para reglas de negocio.
 */
export interface StoredFileMaintenancePort {
  /** Archivos PENDING creados hace más de `olderThanMinutes`, del más viejo al más nuevo. */
  findOrphans(p: { olderThanMinutes: number; limit: number }): Promise<OrphanFile[]>
  /**
   * Pasa a DELETED los `ids` que siguen en `expectedStatus`, con `deleted_at = now()` y
   * `purge_after = now() + purgeAfterDays`. El estado esperado se comprueba en el mismo UPDATE: una
   * fila que otra transacción ya movió no se toca. Devuelve los ids que cambió.
   */
  markDeleted(p: {
    ids: readonly string[]
    expectedStatus: DeletableFileStatus
    purgeAfterDays: number
  }): Promise<string[]>
  /** Archivos DELETED de `bucket` con `purge_after <= now()` y sin `purged_at`, los vencidos primero. */
  findPurgeable(p: { bucket: string; limit: number }): Promise<PurgeableFile[]>
  /** Fija `purged_at = now()` en los que todavía no lo tienen. Devuelve cuántos cambió. */
  markPurged(ids: readonly string[]): Promise<number>
}

export const STORED_FILE_MAINTENANCE = Symbol('STORED_FILE_MAINTENANCE')
