import { describe, expect, it } from 'vitest'
import type {
  DeletableFileStatus,
  OrphanFile,
  StoredFileMaintenancePort,
} from '../ports/stored-file-maintenance.port.js'
import { SweepOrphanFilesUseCase } from './sweep-orphan-files.use-case.js'

type Row = { id: string; status: 'PENDING' | 'ATTACHED' | 'DELETED'; ageMinutes: number }
type MarkDeletedCall = {
  ids: string[]
  expectedStatus: DeletableFileStatus
  purgeAfterDays: number
}

/** `stored_files` en memoria con la misma semántica que el repositorio de Prisma. */
class InMemoryFiles implements Pick<StoredFileMaintenancePort, 'findOrphans' | 'markDeleted'> {
  readonly findCalls: { olderThanMinutes: number; limit: number }[] = []
  readonly markCalls: MarkDeletedCall[] = []
  /** Ids que otra transacción confirma (ATTACHED) justo antes del UPDATE del barrido. */
  attachBeforeUpdate = new Set<string>()

  constructor(readonly rows: Row[]) {}

  async findOrphans(p: { olderThanMinutes: number; limit: number }): Promise<OrphanFile[]> {
    this.findCalls.push(p)
    return this.rows
      .filter((row) => row.status === 'PENDING' && row.ageMinutes > p.olderThanMinutes)
      .sort((a, b) => b.ageMinutes - a.ageMinutes)
      .slice(0, p.limit)
      .map((row) => ({ id: row.id, key: `k/${row.id}`, createdAt: new Date(0) }))
  }

  async markDeleted(p: {
    ids: readonly string[]
    expectedStatus: DeletableFileStatus
    purgeAfterDays: number
  }): Promise<string[]> {
    this.markCalls.push({ ...p, ids: [...p.ids] })
    const changed: string[] = []
    for (const row of this.rows) {
      if (this.attachBeforeUpdate.has(row.id)) row.status = 'ATTACHED'
      if (p.ids.includes(row.id) && row.status === p.expectedStatus) {
        row.status = 'DELETED'
        changed.push(row.id)
      }
    }
    return changed
  }
}

const pending = (id: string, ageMinutes: number): Row => ({ id, status: 'PENDING', ageMinutes })
const options = { graceMinutes: 60, batchSize: 2, maxBatches: 10 }

describe('SweepOrphanFilesUseCase', () => {
  it('da de baja los PENDING más viejos que la gracia, con borrado físico inmediato', async () => {
    const files = new InMemoryFiles([pending('viejo', 61), pending('reciente', 5)])

    await expect(new SweepOrphanFilesUseCase(files, options).execute()).resolves.toEqual({
      swept: 1,
    })
    expect(files.markCalls).toEqual([
      { ids: ['viejo'], expectedStatus: 'PENDING', purgeAfterDays: 0 },
    ])
    expect(files.findCalls[0]).toEqual({ olderThanMinutes: 60, limit: 2 })
    expect(files.rows.map((row) => row.status)).toEqual(['DELETED', 'PENDING'])
  })

  it('nunca toca archivos ATTACHED, aunque sean viejos', async () => {
    const files = new InMemoryFiles([{ id: 'confirmado', status: 'ATTACHED', ageMinutes: 600 }])

    await expect(new SweepOrphanFilesUseCase(files, options).execute()).resolves.toEqual({
      swept: 0,
    })
    expect(files.markCalls).toEqual([])
  })

  it('recorre lotes hasta que uno sale incompleto', async () => {
    const files = new InMemoryFiles(['a', 'b', 'c', 'd', 'e'].map((id) => pending(id, 90)))

    await expect(new SweepOrphanFilesUseCase(files, options).execute()).resolves.toEqual({
      swept: 5,
    })
    expect(files.findCalls).toHaveLength(3)
  })

  it('se detiene en maxBatches y deja el resto para la próxima pasada', async () => {
    const files = new InMemoryFiles(['a', 'b', 'c', 'd', 'e'].map((id) => pending(id, 90)))
    const sweep = new SweepOrphanFilesUseCase(files, { ...options, maxBatches: 2 })

    await expect(sweep.execute()).resolves.toEqual({ swept: 4 })
    expect(files.rows.filter((row) => row.status === 'PENDING')).toHaveLength(1)
  })

  it('cuenta solo las filas que el UPDATE cambió: una confirmada a último momento queda ATTACHED', async () => {
    const files = new InMemoryFiles([pending('huerfano', 90), pending('confirmado', 90)])
    files.attachBeforeUpdate.add('confirmado')

    await expect(new SweepOrphanFilesUseCase(files, options).execute()).resolves.toEqual({
      swept: 1,
    })
    expect(files.rows).toEqual([
      { id: 'huerfano', status: 'DELETED', ageMinutes: 90 },
      { id: 'confirmado', status: 'ATTACHED', ageMinutes: 90 },
    ])
  })

  it('rechaza una gracia que no sea un entero de al menos un minuto', () => {
    const files = new InMemoryFiles([])
    for (const graceMinutes of [0, -5, 1.5]) {
      expect(() => new SweepOrphanFilesUseCase(files, { ...options, graceMinutes })).toThrow(
        RangeError,
      )
    }
  })
})
