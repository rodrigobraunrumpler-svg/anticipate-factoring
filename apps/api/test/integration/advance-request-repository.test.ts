import { createHash } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Prisma } from '#/infrastructure/prisma/generated/client.js'
import { newId } from '#/infrastructure/prisma/id.js'
import {
  openInvoiceKeysQuery,
  PrismaAdvanceRequestRepository,
} from '#/infrastructure/prisma/repositories/advance-requests/prisma-advance-request.repository.js'
import type { NewAdvanceRequest, ReservedFile } from '#/modules/advance-requests/index.js'
import { testConfig } from '../support/config.js'
import { createTestPrisma, truncateAll } from '../support/db.js'

const db = createTestPrisma()
const { database, outbox, storage } = testConfig()
const repository = new PrismaAdvanceRequestRepository(db.prisma, {
  transactionTimeoutMs: database.transactionTimeoutMs,
  transactionMaxWaitMs: database.transactionMaxWaitMs,
  outboxMaxAttempts: outbox.maxAttempts,
})

const reserved = (key: string): ReservedFile => ({
  id: newId(),
  bucket: storage.bucket,
  key,
  purpose: 'INVOICE_XML',
  contentType: 'application/xml',
  sizeBytes: 10,
  sha256: createHash('sha256').update(key).digest('hex'),
})

beforeEach(async () => {
  await truncateAll(db.prisma)
})

afterAll(async () => {
  await db.close()
})

describe('PrismaAdvanceRequestRepository', () => {
  it('findInvoiceKeysInOpenRequests usa el índice parcial invoices_open_invoice_key_key', async () => {
    const plan = await db.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`
      return tx.$queryRaw<{ 'QUERY PLAN': string }[]>(
        Prisma.sql`EXPLAIN ${openInvoiceKeysQuery(['20100070970|F001-123'])}`,
      )
    })
    expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain(
      'invoices_open_invoice_key_key',
    )
    await expect(
      repository.findInvoiceKeysInOpenRequests(['20100070970|F001-123']),
    ).resolves.toEqual([])
  })

  it('reserveFiles deja las filas PENDING y releaseFiles las pasa a DELETED con purge_after', async () => {
    const files = [reserved('pruebas/a.xml'), reserved('pruebas/b.xml')]
    await repository.reserveFiles(files)
    expect(
      (await db.prisma.storedFile.findMany({ orderBy: { key: 'asc' } })).map((f) => f.status),
    ).toEqual(['PENDING', 'PENDING'])

    const first = files[0]?.id ?? ''
    await expect(repository.releaseFiles([first])).resolves.toEqual([first])
    const rows = await db.prisma.storedFile.findMany({ orderBy: { key: 'asc' } })
    expect(rows.map((f) => [f.status, f.deletedAt !== null, f.purgeAfter !== null])).toEqual([
      ['DELETED', true, true],
      ['PENDING', false, false],
    ])
    // Vence de inmediato para la purga: `purge_after <= now()` ya en la consulta siguiente.
    const [due] = await db.prisma.$queryRaw<{ due: boolean }[]>`
      SELECT purge_after <= now() AS due FROM stored_files WHERE id = ${first}::uuid`
    expect(due?.due).toBe(true)
    // Liberar otra vez no devuelve nada: la fila ya no está PENDING.
    await expect(repository.releaseFiles([first])).resolves.toEqual([])
  })

  it('releaseFiles no toca un archivo ATTACHED y no lo devuelve', async () => {
    const [attached, pending] = [reserved('pruebas/a.xml'), reserved('pruebas/b.xml')]
    await repository.reserveFiles([attached, pending])
    await db.prisma.storedFile.update({
      where: { id: attached.id },
      data: { status: 'ATTACHED', attachedAt: new Date() },
    })
    await expect(repository.releaseFiles([attached.id, pending.id])).resolves.toEqual([pending.id])
    const rows = await db.prisma.storedFile.findMany({ orderBy: { key: 'asc' } })
    expect(rows.map((f) => f.status)).toEqual(['ATTACHED', 'DELETED'])
  })

  it('una reserva con una clave repetida no deja ninguna fila', async () => {
    const file = reserved('pruebas/a.xml')
    await expect(repository.reserveFiles([file, reserved('pruebas/a.xml')])).rejects.toThrow()
    expect(await db.prisma.storedFile.count()).toBe(0)
  })
})

describe('PrismaAdvanceRequestRepository: cancelación (plazo del envío, D57)', () => {
  it('con la señal ya cancelada, lecturas, liberación y transacción rechazan con su motivo sin tocar la base', async () => {
    const [file] = [reserved('pruebas/a.xml')]
    await repository.reserveFiles([file])
    const controller = new AbortController()
    const reason = new Error('plazo del envío')
    controller.abort(reason)
    const options = { signal: controller.signal }

    await expect(repository.findByIdempotencyKey(newId(), options)).rejects.toBe(reason)
    await expect(
      repository.findInvoiceKeysInOpenRequests(['20100070970|F001-1'], options),
    ).rejects.toBe(reason)
    await expect(repository.releaseFiles([file.id], options)).rejects.toBe(reason)
    // Rechaza antes de mirar la solicitud: ni abre la transacción.
    await expect(repository.create({} as NewAdvanceRequest, () => [], options)).rejects.toBe(reason)
    expect((await db.prisma.storedFile.findMany()).map((f) => f.status)).toEqual(['PENDING'])
  })

  it('una lectura que espera un candado rechaza en el acto al cancelarse', async () => {
    let release: () => void = () => undefined
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let markLocked: () => void = () => undefined
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve
    })
    const holding = db.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('LOCK TABLE advance_requests IN ACCESS EXCLUSIVE MODE')
      markLocked()
      await released
    })
    await locked
    try {
      const controller = new AbortController()
      const reading = repository.findByIdempotencyKey(newId(), { signal: controller.signal })
      await new Promise((resolve) => setTimeout(resolve, 150))
      const reason = new Error('plazo del envío')
      const startedAt = Date.now()
      controller.abort(reason)
      await expect(reading).rejects.toBe(reason)
      expect(Date.now() - startedAt).toBeLessThan(100)
    } finally {
      release()
      await holding
    }
  })
})
