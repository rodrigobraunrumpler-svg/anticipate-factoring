import type { PrismaService } from '#/infrastructure/prisma/prisma.service.js'
import type {
  DeletableFileStatus,
  OrphanFile,
  PurgeableFile,
  StoredFileMaintenancePort,
} from '#/modules/maintenance/index.js'

/**
 * SQL crudo a propósito: los tiempos salen de `now()` de la base, nunca del reloj de la app, y el
 * barrido escribe `status = 'PENDING'` como literal para que PostgreSQL use el índice parcial de
 * pendientes (con el query builder, Prisma manda el enum como parámetro y el índice no se usa). El
 * borrado diferido filtra con `purged_at IS NULL AND deleted_at IS NOT NULL`, el predicado de su
 * índice parcial.
 */
export class PrismaStoredFileMaintenanceRepository implements StoredFileMaintenancePort {
  constructor(private readonly prisma: PrismaService) {}

  findOrphans(p: { olderThanMinutes: number; limit: number }): Promise<OrphanFile[]> {
    return this.prisma.$queryRaw<OrphanFile[]>`
      SELECT id, key, created_at AS "createdAt"
        FROM stored_files
       WHERE status = 'PENDING'
         AND created_at < now() - make_interval(mins => ${p.olderThanMinutes}::int)
       ORDER BY created_at
       LIMIT ${p.limit}::int`
  }

  async markDeleted(p: {
    ids: readonly string[]
    expectedStatus: DeletableFileStatus
    purgeAfterDays: number
  }): Promise<string[]> {
    if (p.ids.length === 0) return []
    // purge_after se trunca al milisegundo: la columna es timestamptz(3) y redondear hacia arriba
    // dejaría un purge_after = now() medio milisegundo en el futuro para el borrado que sigue.
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE stored_files
         SET status = 'DELETED',
             deleted_at = now(),
             purge_after = date_trunc('milliseconds', now())
                           + make_interval(days => ${p.purgeAfterDays}::int)
       WHERE id = ANY(${p.ids}::uuid[])
         AND status = ${p.expectedStatus}
      RETURNING id`
    return rows.map((row) => row.id)
  }

  findPurgeable(p: { bucket: string; limit: number }): Promise<PurgeableFile[]> {
    return this.prisma.$queryRaw<PurgeableFile[]>`
      SELECT id, key
        FROM stored_files
       WHERE purged_at IS NULL
         AND deleted_at IS NOT NULL
         AND purge_after <= now()
         AND storage_bucket = ${p.bucket}
       ORDER BY purge_after
       LIMIT ${p.limit}::int`
  }

  async markPurged(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0
    return this.prisma.$executeRaw`
      UPDATE stored_files
         SET purged_at = now()
       WHERE id = ANY(${ids}::uuid[])
         AND status = 'DELETED'
         AND purged_at IS NULL`
  }
}
