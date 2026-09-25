import { defineConfig } from 'prisma/config'

// Configuración de la CLI de Prisma (generate, migrate, db seed). La app no la usa: arma su pool en
// PrismaService con la configuración validada. Prisma 7 no lee .env por su cuenta; loadEnvFile no
// pisa las variables que ya están en el entorno (las del job de CI o las de la línea de comandos).
try {
  process.loadEnvFile()
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
}

/** Comandos que no se conectan a la base: corren sin URL (la imagen Docker genera el cliente sin base). */
const OFFLINE_COMMANDS = new Set(['generate', 'validate', 'format', 'version', '--version', '-v'])
const OFFLINE_URL = 'postgresql://sin-configurar@127.0.0.1:5432/sin-configurar'

/**
 * URL con la que la CLI se conecta. Siempre la directa si existe: `DATABASE_URL` es la de la app, que
 * en producción pasa por el pooler de Neon (PgBouncer en modo transacción), y las migraciones nunca
 * van por el pooler. `directUrl` ya no existe en Prisma 7: la URL directa va en `datasource.url`.
 */
function cliDatabaseUrl(env: NodeJS.ProcessEnv, command: string): string {
  const direct = env.DATABASE_DIRECT_URL?.trim()
  if (direct) return direct
  if (OFFLINE_COMMANDS.has(command)) return env.DATABASE_URL?.trim() || OFFLINE_URL
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'Falta DATABASE_DIRECT_URL: en producción la CLI de Prisma nunca usa DATABASE_URL, que pasa por el pooler de Neon.',
    )
  }
  const url = env.DATABASE_URL?.trim()
  if (!url) throw new Error('Falta DATABASE_URL (o DATABASE_DIRECT_URL) para la CLI de Prisma.')
  return url
}

/** Base desechable de `migrate dev` y `db:check-drift`: Prisma la vacía cada vez que la usa. */
function shadowDatabase(env: NodeJS.ProcessEnv, url: string): { shadowDatabaseUrl?: string } {
  const shadow = env.SHADOW_DATABASE_URL?.trim()
  if (!shadow) return {}
  if (shadow === url) {
    throw new Error(
      'SHADOW_DATABASE_URL no puede ser la misma base que migra la CLI: Prisma la vacía cada vez.',
    )
  }
  return { shadowDatabaseUrl: shadow }
}

const url = cliDatabaseUrl(process.env, process.argv[2] ?? '')

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx --conditions=@anticipate/source prisma/seed.ts',
  },
  datasource: { url, ...shadowDatabase(process.env, url) },
})
