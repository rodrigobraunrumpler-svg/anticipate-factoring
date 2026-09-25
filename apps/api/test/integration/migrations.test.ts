import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Reglas de migración de docs/database/migrations.md que se pueden comprobar leyendo los archivos.
 * `migrationProblems` devuelve una línea en español por regla rota; los casos virtuales del final
 * prueban que cada regla detecta su violación.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url))
/** Las dos migraciones del paso 2 corren con las tablas vacías en todo entorno. */
const BASELINE = /^\d{14}_(init|integrity)$/

type Migration = { name: string; sql: string }

/** Sin líneas de comentario ni líneas vacías. */
function code(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('--'))
    .join('\n')
    .trim()
}

/** Sentencias ALTER TABLE con el nombre de su tabla (el SQL que genera Prisma y el de a mano). */
function alterTableStatements(text: string): { table: string; body: string }[] {
  return [...text.matchAll(/ALTER TABLE\s+(?:ONLY\s+)?"?(\w+)"?\s+([^;]*);/gi)].map((match) => ({
    table: match[1] ?? '',
    body: match[2] ?? '',
  }))
}

function migrationProblems({ name, sql }: Migration): string[] {
  const problems: string[] = []
  const text = code(sql)
  const count = (pattern: RegExp) => (text.match(pattern) ?? []).length

  // 1. Transacción explícita, salvo CREATE INDEX CONCURRENTLY, que va sola.
  if (/\bCONCURRENTLY\b/i.test(text)) {
    const statements = text
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean)
    if (
      statements.length !== 1 ||
      !/^(CREATE (UNIQUE )?INDEX|DROP INDEX) CONCURRENTLY\b/i.test(statements[0] ?? '')
    ) {
      problems.push(
        `${name}: una migración con CONCURRENTLY lleva una sola sentencia de índice y ninguna transacción`,
      )
    }
  } else if (
    !/^BEGIN;\nSET LOCAL lock_timeout = '[^']+';\nSET LOCAL statement_timeout = '[^']+';\n/.test(
      `${text}\n`,
    ) ||
    !/\nCOMMIT;$/.test(text) ||
    count(/^BEGIN;$/gm) !== 1 ||
    count(/^COMMIT;$/gm) !== 1
  ) {
    problems.push(
      `${name}: debe empezar con BEGIN y los SET LOCAL de lock_timeout y statement_timeout, y terminar con COMMIT`,
    )
  }

  // 2. ALTER TYPE ADD VALUE va en un archivo sin CHECK, índices ni UPDATE.
  if (
    /\bALTER TYPE\s+\S+\s+ADD VALUE\b/i.test(text) &&
    /\bCHECK\s*\(|\bCREATE\s+(UNIQUE\s+)?INDEX\b|\bUPDATE\s+\S+\s+SET\b/i.test(text)
  ) {
    problems.push(`${name}: ALTER TYPE ADD VALUE va en una migración sin CHECK, índices ni UPDATE`)
  }

  // 3. En producción nunca se quita ni se renombra un valor de enum.
  if (/\bRENAME VALUE\b|\bDROP TYPE\b|\bALTER TYPE\s+\S+\s+RENAME TO\b/i.test(text)) {
    problems.push(
      `${name}: no se quita ni se renombra un enum ni sus valores; se marca obsoleto en shared`,
    )
  }

  const statements = alterTableStatements(text)
  const created = new Set([...text.matchAll(/CREATE TABLE\s+"?(\w+)"?/gi)].map((match) => match[1]))

  // 4. Un renombre de columna nunca es DROP COLUMN + ADD COLUMN (el DROP borra sus CHECK en silencio).
  for (const table of new Set(statements.map((statement) => statement.table))) {
    const bodies = statements
      .filter((statement) => statement.table === table)
      .map((statement) => statement.body)
    if (
      bodies.some((body) => /\bDROP COLUMN\b/i.test(body)) &&
      bodies.some((body) => /\bADD COLUMN\b/i.test(body))
    ) {
      problems.push(
        `${name}: ${table} quita y agrega columnas en la misma migración; un renombre es RENAME COLUMN`,
      )
    }
  }

  // 5. Fuera de la línea base, CHECK y FK nuevas en tablas existentes van NOT VALID y se validan en otra migración.
  if (!BASELINE.test(name)) {
    for (const { table, body } of statements) {
      const added = (body.match(/\bADD CONSTRAINT\s+"?\w+"?\s+(CHECK|FOREIGN KEY)\b/gi) ?? [])
        .length
      const notValid = (body.match(/\bNOT VALID\b/gi) ?? []).length
      if (added > notValid && !created.has(table)) {
        problems.push(
          `${name}: la CHECK o FK nueva de ${table} va con NOT VALID y se valida en otra migración`,
        )
      }
    }
  }
  for (const match of text.matchAll(/VALIDATE CONSTRAINT\s+"?(\w+)"?/gi)) {
    if (new RegExp(`ADD CONSTRAINT\\s+"?${match[1]}"?[^;]*NOT VALID`, 'i').test(text)) {
      problems.push(`${name}: ${match[1]} se agrega NOT VALID y se valida en la misma migración`)
    }
  }
  return problems
}

function readMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'),
    }))
}

describe('reglas de migración (docs/database/migrations.md)', () => {
  const migrations = readMigrations()

  it('las carpetas tienen nombre <timestamp>_<nombre>, su migration.sql y el lock de PostgreSQL', () => {
    expect(migrations.map((m) => m.name).slice(0, 2)).toEqual([
      expect.stringMatching(/^\d{14}_init$/),
      expect.stringMatching(/^\d{14}_integrity$/),
    ])
    for (const { name } of migrations) {
      expect(name).toMatch(/^\d{14}_[a-z0-9_]+$/)
    }
    expect(existsSync(join(MIGRATIONS_DIR, 'migration_lock.toml'))).toBe(true)
    expect(readFileSync(join(MIGRATIONS_DIR, 'migration_lock.toml'), 'utf8')).toMatch(
      /provider\s*=\s*"postgresql"/,
    )
  })

  it.each(migrations)('$name cumple las reglas', (migration) => {
    expect(migrationProblems(migration)).toEqual([])
  })

  const wrap = (body: string) =>
    `BEGIN;\nSET LOCAL lock_timeout = '5s';\nSET LOCAL statement_timeout = '60s';\n${body}\nCOMMIT;\n`

  it.each([
    { rule: 'sin transacción', sql: 'ALTER TABLE "payers" ADD COLUMN "x" TEXT;' },
    {
      rule: 'transacción sin timeouts',
      sql: 'BEGIN;\nALTER TABLE "payers" ADD COLUMN "x" TEXT;\nCOMMIT;',
    },
    {
      rule: 'CONCURRENTLY dentro de una transacción',
      sql: wrap('CREATE INDEX CONCURRENTLY "x_idx" ON "payers"("slug");'),
    },
    {
      rule: 'CONCURRENTLY con otra sentencia',
      sql: 'CREATE INDEX CONCURRENTLY "x_idx" ON "payers"("slug");\nCREATE INDEX CONCURRENTLY "y_idx" ON "payers"("ruc");',
    },
    {
      rule: 'ADD VALUE junto a un UPDATE',
      sql: wrap(
        `ALTER TYPE "advance_request_status" ADD VALUE 'ON_HOLD';\nUPDATE "advance_requests" SET "version" = 1;`,
      ),
    },
    {
      rule: 'valor de enum renombrado',
      sql: wrap(`ALTER TYPE "currency" RENAME VALUE 'PEN' TO 'SOL';`),
    },
    {
      rule: 'enum recreado por Prisma',
      sql: wrap('ALTER TYPE "currency" RENAME TO "currency_old";\nDROP TYPE "currency_old";'),
    },
    {
      rule: 'renombre como DROP + ADD',
      sql: wrap(
        'ALTER TABLE "payers" DROP COLUMN "short_name",\nADD COLUMN "display_name" VARCHAR(40) NOT NULL;',
      ),
    },
    {
      rule: 'CHECK nueva sin NOT VALID',
      sql: wrap(
        'ALTER TABLE "payers" ADD CONSTRAINT "payers_x_check" CHECK (min_term_days < 365);',
      ),
    },
    {
      rule: 'NOT VALID y VALIDATE juntos',
      sql: wrap(
        'ALTER TABLE "payers" ADD CONSTRAINT "payers_x_check" CHECK (min_term_days < 365) NOT VALID;\nALTER TABLE "payers" VALIDATE CONSTRAINT "payers_x_check";',
      ),
    },
  ])('detecta: $rule', ({ sql }) => {
    expect(migrationProblems({ name: '20990101000000_virtual', sql })).toHaveLength(1)
  })

  it.each([
    {
      rule: 'CHECK nueva NOT VALID',
      sql: wrap(
        'ALTER TABLE "payers" ADD CONSTRAINT "payers_x_check" CHECK (min_term_days < 365) NOT VALID;',
      ),
    },
    {
      rule: 'VALIDATE en su propia migración',
      sql: wrap('ALTER TABLE "payers" VALIDATE CONSTRAINT "payers_x_check";'),
    },
    {
      rule: 'FK de una tabla nueva',
      sql: wrap(
        'CREATE TABLE "notes" ("id" UUID NOT NULL, "payer_id" UUID NOT NULL, CONSTRAINT "notes_pkey" PRIMARY KEY ("id"));\nALTER TABLE "notes" ADD CONSTRAINT "notes_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "payers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;',
      ),
    },
    {
      rule: 'índice concurrente solo',
      sql: 'CREATE INDEX CONCURRENTLY "payers_x_idx" ON "payers"("short_name");',
    },
    {
      rule: 'valor de enum nuevo solo',
      sql: wrap(`ALTER TYPE "advance_request_status" ADD VALUE 'ON_HOLD';`),
    },
  ])('acepta: $rule', ({ sql }) => {
    expect(migrationProblems({ name: '20990101000000_virtual', sql })).toEqual([])
  })
})
