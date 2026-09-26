import { describe, expect, it } from 'vitest'
import type { FileStoragePort } from '#/common/storage/file-storage.port.js'
import type {
  PurgeableFile,
  StoredFileMaintenancePort,
} from '../ports/stored-file-maintenance.port.js'
import { PurgeDeletedFilesUseCase } from './purge-deleted-files.use-case.js'

type Row = { id: string; bucket: string; due: boolean; purged: boolean }

/** Filas DELETED en memoria: `due` es `purge_after <= now()`. */
class InMemoryDeletedFiles
  implements Pick<StoredFileMaintenancePort, 'findPurgeable' | 'markPurged'>
{
  readonly findCalls: { bucket: string; limit: number }[] = []
  readonly markCalls: string[][] = []

  constructor(readonly rows: Row[]) {}

  async findPurgeable(p: { bucket: string; limit: number }): Promise<PurgeableFile[]> {
    this.findCalls.push(p)
    return this.rows
      .filter((row) => row.bucket === p.bucket && row.due && !row.purged)
      .slice(0, p.limit)
      .map((row) => ({ id: row.id, key: `k/${row.id}` }))
  }

  async markPurged(ids: readonly string[]): Promise<number> {
    this.markCalls.push([...ids])
    let changed = 0
    for (const row of this.rows) {
      if (ids.includes(row.id) && !row.purged) {
        row.purged = true
        changed += 1
      }
    }
    return changed
  }
}

/** Almacenamiento falso: `failing` son las claves que no logra borrar. */
class FakeStorage implements Pick<FileStoragePort, 'bucket' | 'deleteQuietly'> {
  readonly bucket = 'anticipate-local'
  readonly deleted: string[] = []
  readonly calls: string[][] = []
  failing = new Set<string>()

  async deleteQuietly(keys: readonly string[]): Promise<string[]> {
    this.calls.push([...keys])
    const notDeleted = keys.filter((key) => this.failing.has(key))
    this.deleted.push(...keys.filter((key) => !this.failing.has(key)))
    return notDeleted
  }
}

const due = (id: string, bucket = 'anticipate-local'): Row => ({
  id,
  bucket,
  due: true,
  purged: false,
})
const options = { batchSize: 2, maxBatches: 10 }

describe('PurgeDeletedFilesUseCase', () => {
  it('borra los objetos vencidos del bucket del adaptador y marca purged_at', async () => {
    const files = new InMemoryDeletedFiles([
      due('a'),
      { id: 'futuro', bucket: 'anticipate-local', due: false, purged: false },
    ])
    const storage = new FakeStorage()

    await expect(new PurgeDeletedFilesUseCase(files, storage, options).execute()).resolves.toEqual({
      purged: 1,
      failed: 0,
    })
    expect(files.findCalls[0]).toEqual({ bucket: 'anticipate-local', limit: 2 })
    expect(storage.deleted).toEqual(['k/a'])
    expect(files.markCalls).toEqual([['a']])
    expect(files.rows.map((row) => row.purged)).toEqual([true, false])
  })

  it('nunca pide filas de otro bucket', async () => {
    const files = new InMemoryDeletedFiles([due('otro', 'bucket-anterior')])
    const storage = new FakeStorage()

    await expect(new PurgeDeletedFilesUseCase(files, storage, options).execute()).resolves.toEqual({
      purged: 0,
      failed: 0,
    })
    expect(storage.calls).toEqual([])
  })

  it('una clave que no se pudo borrar queda sin purged_at y corta la pasada', async () => {
    const files = new InMemoryDeletedFiles([due('a'), due('b'), due('c')])
    const storage = new FakeStorage()
    storage.failing.add('k/b')

    await expect(new PurgeDeletedFilesUseCase(files, storage, options).execute()).resolves.toEqual({
      purged: 1,
      failed: 1,
    })
    expect(files.markCalls).toEqual([['a']])
    expect(files.findCalls).toHaveLength(1)
    expect(files.rows.filter((row) => !row.purged).map((row) => row.id)).toEqual(['b', 'c'])
  })

  it('si no se pudo borrar nada no escribe en la base', async () => {
    const files = new InMemoryDeletedFiles([due('a')])
    const storage = new FakeStorage()
    storage.failing.add('k/a')

    await expect(new PurgeDeletedFilesUseCase(files, storage, options).execute()).resolves.toEqual({
      purged: 0,
      failed: 1,
    })
    expect(files.markCalls).toEqual([])
  })

  it('recorre lotes hasta vaciar la cola y respeta maxBatches', async () => {
    const rows = () => ['a', 'b', 'c', 'd', 'e'].map((id) => due(id))
    const all = new InMemoryDeletedFiles(rows())
    await expect(
      new PurgeDeletedFilesUseCase(all, new FakeStorage(), options).execute(),
    ).resolves.toEqual({ purged: 5, failed: 0 })
    expect(all.findCalls).toHaveLength(3)

    const capped = new InMemoryDeletedFiles(rows())
    await expect(
      new PurgeDeletedFilesUseCase(capped, new FakeStorage(), {
        ...options,
        maxBatches: 2,
      }).execute(),
    ).resolves.toEqual({ purged: 4, failed: 0 })
  })
})
