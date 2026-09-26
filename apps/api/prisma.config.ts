import { defineConfig } from 'prisma/config'
import { resolveCliDatasource } from './prisma/cli-guard.js'

// Configuración de la CLI de Prisma (generate, migrate, db seed). La app no la usa: arma su pool en
// PrismaService con la configuración validada. Prisma 7 no lee .env por su cuenta; loadEnvFile no
// pisa las variables que ya están en el entorno (las del job de CI o las de la línea de comandos).
try {
  process.loadEnvFile()
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx --conditions=@anticipate/source prisma/seed.ts',
  },
  // URL directa, nunca el pooler, y comandos destructivos solo contra una base local: ver las reglas
  // en prisma/cli-guard.ts. `directUrl` ya no existe en Prisma 7: la URL directa va en `url`.
  datasource: resolveCliDatasource(process.env, process.argv),
})
