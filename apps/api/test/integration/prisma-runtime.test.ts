import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  DATABASE_APPLICATION_NAME,
  databaseErrorInfo,
  newId,
  uniqueViolationIndex,
} from '#/infrastructure/prisma/index.js'
import { CATALOG_TABLES, createTestPrisma, tablesToTruncate, truncateAll } from '../support/db.js'
import {
  createPayer,
  createSupplier,
  SEA,
  TEST_LEGAL_DOCUMENT_VERSIONS,
} from '../support/factories.js'

const db = createTestPrisma()
const { prisma } = db

/** Hash con el formato de argon2id: cumple la CHECK de `users.password_hash` de la Tarea 7. */
const ARGON2ID_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo'

beforeEach(async () => {
  await truncateAll(prisma)
})

afterAll(async () => {
  await db.close()
})

describe('PrismaService contra PostgreSQL', () => {
  it('se identifica como anticipate-api en pg_stat_activity', async () => {
    const [row] = await prisma.$queryRaw<{ name: string }[]>`
      SELECT current_setting('application_name') AS name`
    expect(row?.name).toBe(DATABASE_APPLICATION_NAME)
  })

  it('omite el hash de la contraseña salvo que la consulta lo pida', async () => {
    await prisma.$executeRaw`
      INSERT INTO users (email, full_name, password_hash, role)
      VALUES ('admin@anticipate.test', 'Administrador', ${ARGON2ID_HASH}, 'ADMIN')`
    const user = await prisma.user.findFirstOrThrow()
    expect(user.email).toBe('admin@anticipate.test')
    expect(user).not.toHaveProperty('passwordHash')
    const forLogin = await prisma.user.findFirstOrThrow({ omit: { passwordHash: false } })
    expect(forLogin.passwordHash).toBe(ARGON2ID_HASH)
  })

  it('la base asigna UUIDv7 también a un INSERT en SQL crudo, y acepta los de newId()', async () => {
    const payer = await createPayer(prisma)
    await prisma.$executeRaw`
      INSERT INTO suppliers (ruc, legal_name) VALUES ('20100070970', 'PROVEEDOR EJEMPLO S.A.C.')`
    const apiId = newId()
    await prisma.supplier.create({
      data: { id: apiId, ruc: '20601234565', legalName: 'OTRO PROVEEDOR S.A.C.' },
    })
    const rows = await prisma.$queryRaw<{ version: number }[]>`
      SELECT uuid_extract_version(id) AS version FROM payers WHERE id = ${payer.id}::uuid
      UNION ALL
      SELECT uuid_extract_version(id) FROM suppliers`
    expect(rows.map((row) => row.version)).toEqual([7, 7, 7])
  })

  it('reconoce el índice único violado con el query builder y con SQL crudo', async () => {
    await createPayer(prisma)
    const fromClient = await createPayer(prisma, { ruc: '20100070970' }).catch((e: unknown) => e)
    expect(uniqueViolationIndex(fromClient)).toBe('payers_slug_key')
    const fromRawSql = await prisma.$executeRaw`
      INSERT INTO payers (slug, ruc, legal_name, short_name, advance_percent, min_term_days,
        max_invoices, allowed_currencies, accent_color)
      VALUES ('otro', ${SEA.ruc}, 'Otro Pagador S.A.', 'Otro', 80, 15, 10, '{PEN}', '#000000')`.catch(
      (e: unknown) => e,
    )
    expect(uniqueViolationIndex(fromRawSql)).toBe('payers_ruc_key')
    expect(databaseErrorInfo(fromRawSql)).toMatchObject({ sqlState: '23505' })
  })

  it('una transacción interactiva respeta DATABASE_TRANSACTION_TIMEOUT_MS', async () => {
    const short = createTestPrisma({ DATABASE_TRANSACTION_TIMEOUT_MS: '1000' })
    try {
      const error = await short.prisma
        .$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_sleep(1.5)`
        })
        .catch((e: unknown) => e)
      expect(databaseErrorInfo(error)?.prismaCode).toBe('P2028')
    } finally {
      await short.close()
    }
  })
})

describe('soporte de los tests de base', () => {
  it('truncateAll reinicia la secuencia del código público', async () => {
    await prisma.$queryRaw`SELECT nextval('advance_request_code_seq')`
    await prisma.$queryRaw`SELECT nextval('advance_request_code_seq')`
    await truncateAll(prisma)
    const [row] = await prisma.$queryRaw<{ value: bigint }[]>`
      SELECT nextval('advance_request_code_seq') AS value`
    expect(row?.value).toBe(1n)
  })

  it('truncateAll vacía las tablas de datos y deja las de catálogo', async () => {
    await createPayer(prisma)
    await createSupplier(prisma)
    const tables = await tablesToTruncate(prisma)
    for (const catalog of CATALOG_TABLES) expect(tables).not.toContain(catalog)
    expect(tables).toEqual(
      expect.arrayContaining(['advance_requests', 'invoices', 'outbox_events', 'payers', 'users']),
    )
    await truncateAll(prisma)
    expect(await prisma.payer.count()).toBe(0)
    expect(await prisma.supplier.count()).toBe(0)
  })

  it('truncateAll vuelve a dejar las versiones legales de prueba', async () => {
    await prisma.legalDocumentVersion.deleteMany()
    await truncateAll(prisma)
    const summary = (rows: readonly { type: string; version: string; retiredAt: Date | null }[]) =>
      rows
        .map(({ type, version, retiredAt }) => ({ type, version, retiredAt }))
        .sort((a, b) => a.type.localeCompare(b.type))
    expect(summary(await prisma.legalDocumentVersion.findMany())).toEqual(
      summary(TEST_LEGAL_DOCUMENT_VERSIONS),
    )
  })
})
