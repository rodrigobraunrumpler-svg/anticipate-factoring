import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import type { TestProject } from 'vitest/node'

/** Archivo con las URLs de los contenedores de prueba (se copia de `.env.test.example`). */
export const TEST_ENV_FILE = fileURLToPath(new URL('../../.env.test', import.meta.url))

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

export default function setup(project: TestProject): void {
  project.provide('testContainerEnv', readTestEnvFile())
}
