import { z } from 'zod'
import { flag, httpUrl, integer, requiredText } from './env-values.js'

/** Nombre de bucket de S3 y R2: 3 a 63 caracteres en minúsculas, dígitos, puntos y guiones. */
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/

/**
 * Almacenamiento de archivos (S3Mock en local, R2 en producción) y su ciclo de vida: cuándo un archivo
 * `PENDING` es huérfano y cuántos días espera un archivo `DELETED` antes del borrado físico (más que
 * la ventana de PITR de la base, para que una restauración nunca apunte a un objeto inexistente).
 */
export const storageShape = {
  S3_ENDPOINT: httpUrl.optional(),
  S3_REGION: requiredText.default('auto'),
  S3_BUCKET: requiredText.regex(BUCKET_NAME, {
    error: 'debe ser un nombre de bucket válido (3 a 63 caracteres: a-z, 0-9, punto y guion)',
  }),
  S3_ACCESS_KEY_ID: requiredText,
  S3_SECRET_ACCESS_KEY: requiredText,
  S3_FORCE_PATH_STYLE: flag(true),
  STORAGE_ORPHAN_GRACE_MINUTES: integer({ fallback: 60, min: 1, max: 10_080 }),
  STORAGE_DELETE_DELAY_DAYS: integer({ fallback: 35, min: 0, max: 3_650 }),
}

const storageSchema = z.object(storageShape)
export type StorageEnvironment = z.output<typeof storageSchema>

export function toStorageConfig(env: StorageEnvironment) {
  return {
    storage: {
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      orphanGraceMinutes: env.STORAGE_ORPHAN_GRACE_MINUTES,
      deleteDelayDays: env.STORAGE_DELETE_DELAY_DAYS,
    },
  }
}
