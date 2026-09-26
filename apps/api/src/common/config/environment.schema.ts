import { z } from 'zod'
import { captchaShape, refineCaptcha } from './schemas/captcha.schema.js'
import { databaseShape, refineDatabase } from './schemas/database.schema.js'
import { httpShape, refineHttp } from './schemas/http.schema.js'
import { mailShape, refineMail } from './schemas/mail.schema.js'
import { maintenanceShape } from './schemas/maintenance.schema.js'
import { outboxShape, refineOutbox } from './schemas/outbox.schema.js'
import { runtimeShape } from './schemas/runtime.schema.js'
import { storageShape } from './schemas/storage.schema.js'
import { throttleShape } from './schemas/throttle.schema.js'
import { refineUpload, uploadShape } from './schemas/upload.schema.js'
import { xmlParserShape } from './schemas/xml-parser.schema.js'

/**
 * Todas las variables de entorno que conoce la API, por tema. Cada archivo de `schemas/` es dueño de
 * las suyas; aquí solo se juntan y se corren las reglas que cruzan variables. `env-example.test.ts`
 * exige que `.env.example` declare exactamente estas claves.
 */
export const environmentShape = {
  ...runtimeShape,
  ...httpShape,
  ...databaseShape,
  ...storageShape,
  ...mailShape,
  ...captchaShape,
  ...uploadShape,
  ...xmlParserShape,
  ...throttleShape,
  ...outboxShape,
  ...maintenanceShape,
}

export type EnvironmentKey = keyof typeof environmentShape

export const ENVIRONMENT_KEYS = Object.keys(environmentShape) as readonly EnvironmentKey[]

/**
 * Variables que lee solo `prisma/seed.ts` (el usuario administrador inicial de `pnpm db:seed`). La API
 * no las conoce y `parseConfig` las ignora; `.env.example` las declara en su propia sección.
 */
export const SEED_ENVIRONMENT_KEYS = ['SEED_ADMIN_EMAIL', 'SEED_ADMIN_PASSWORD'] as const

export const environmentSchema = z.object(environmentShape).superRefine((env, ctx) => {
  refineHttp(env, ctx)
  refineDatabase(env, ctx)
  refineMail(env, ctx)
  refineCaptcha(env, ctx)
  refineUpload(env, ctx)
  refineOutbox(env, ctx)
})

export type Environment = z.output<typeof environmentSchema>
