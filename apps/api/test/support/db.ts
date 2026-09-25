import { PrismaService } from '#/infrastructure/prisma/index.js'
import { testConfig } from './config.js'
import { createLegalDocumentVersions } from './factories.js'

/**
 * Tablas que `truncateAll` no vacía: el historial de migraciones y los catálogos que llena la
 * migración `integrity` (máquina de estados y motivos de cierre). Un test nunca escribe en ellas.
 */
export const CATALOG_TABLES: readonly string[] = [
  '_prisma_migrations',
  'advance_request_transitions',
  'close_reason_rules',
]

export type TestDatabase = { prisma: PrismaService; close: () => Promise<void> }

/**
 * Cliente de los tests de integración: el mismo `PrismaService` de la app (pool, `omit` y límites de
 * transacción) contra `anticipate_test`, con un pool chico. `close()` lo apaga como lo hace Nest.
 */
export function createTestPrisma(
  overrides: Readonly<Record<string, string | undefined>> = {},
): TestDatabase {
  const prisma = new PrismaService(testConfig({ DATABASE_POOL_MAX: '4', ...overrides }))
  return { prisma, close: () => prisma.onApplicationShutdown() }
}

/** Tablas de `public` que vacía `truncateAll`, en orden alfabético. */
export async function tablesToTruncate(prisma: PrismaService): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename`
  return rows.map((row) => row.tablename).filter((table) => !CATALOG_TABLES.includes(table))
}

/**
 * Deja la base como recién migrada: vacía toda tabla que no es de catálogo en un solo `TRUNCATE` (sin
 * `CASCADE`: si algún día un catálogo apuntara a una tabla de datos, falla en vez de vaciarlo),
 * reinicia la secuencia del código público y vuelve a insertar las versiones legales de prueba. Solo
 * trunca bases cuyo nombre termina en `_test`.
 */
export async function truncateAll(prisma: PrismaService): Promise<void> {
  const [current] = await prisma.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`
  if (!current?.name.endsWith('_test')) {
    throw new Error(
      `truncateAll se negó a vaciar la base «${current?.name ?? 'desconocida'}»: solo trunca bases que terminan en _test.`,
    )
  }
  const tables = await tablesToTruncate(prisma)
  if (tables.length > 0) {
    const list = tables.map((table) => `"public"."${table.replaceAll('"', '""')}"`).join(', ')
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY`)
  }
  await prisma.$executeRawUnsafe('ALTER SEQUENCE "advance_request_code_seq" RESTART WITH 1')
  await createLegalDocumentVersions(prisma)
}
