import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import type { TestProject } from 'vitest/node'

/** Archivo con las URLs de los contenedores de prueba (se copia de `.env.test.example`). */
export const TEST_ENV_FILE = fileURLToPath(new URL('../../.env.test', import.meta.url))

/** Raíz de `apps/api`: donde corre la CLI de Prisma. */
const API_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * Lee `apps/api/.env.test`. Es la única fuente de las URLs de los contenedores: una variable
 * exportada en la terminal o en un job de CI nunca llega a los tests. Sin el archivo, no corren.
 */
export function readTestEnvFile(): Record<string, string> {
  if (!existsSync(TEST_ENV_FILE)) {
    throw new Error(
      'Falta apps/api/.env.test. Cópialo desde apps/api/.env.test.example (ajusta los puertos si tu máquina los cambia) y levanta los contenedores con pnpm infra:up.',
    )
  }
  return parseEnv(readFileSync(TEST_ENV_FILE, 'utf8')) as Record<string, string>
}

/** URL a la que se aplican las migraciones: la directa del archivo, y siempre una base `_test`. */
function migrationUrl(env: Readonly<Record<string, string>>): string {
  const url = env.DATABASE_DIRECT_URL?.trim() || env.DATABASE_URL?.trim()
  if (!url) throw new Error('apps/api/.env.test no declara DATABASE_URL.')
  const database = decodeURIComponent(new URL(url).pathname.slice(1))
  if (!database.endsWith('_test')) {
    throw new Error(
      `apps/api/.env.test apunta a la base «${database}»: las migraciones de los tests solo se aplican a una base que termine en _test.`,
    )
  }
  return url
}

/**
 * Antes de los tests de integración: aplica las migraciones pendientes a `anticipate_test` con
 * `prisma migrate deploy` (nunca `migrate dev` ni `migrate reset`) y entrega las variables del archivo
 * a `testEnv` con `provide`/`inject` de Vitest. El proceso de Prisma recibe las URLs del archivo
 * explícitas, así que el `.env` de desarrollo que carga `prisma.config.ts` no las reemplaza.
 */
export default function setup(project: TestProject): void {
  const env = readTestEnvFile()
  const url = migrationUrl(env)
  const shadow = env.SHADOW_DATABASE_URL?.trim()
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: API_ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: url,
      DATABASE_DIRECT_URL: url,
      ...(shadow ? { SHADOW_DATABASE_URL: shadow } : {}),
    },
  })
  project.provide('testContainerEnv', env)
}
