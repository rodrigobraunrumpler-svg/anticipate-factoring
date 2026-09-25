import { z } from 'zod'
import { flag, integer } from './env-values.js'

/** Tareas periódicas: purga del outbox, barrido de archivos huérfanos y borrado diferido. */
export const maintenanceShape = {
  MAINTENANCE_ENABLED: flag(true),
  MAINTENANCE_INTERVAL_MS: integer({ fallback: 3_600_000, min: 1_000, max: 86_400_000 }),
}

const maintenanceSchema = z.object(maintenanceShape)
export type MaintenanceEnvironment = z.output<typeof maintenanceSchema>

export function toMaintenanceConfig(env: MaintenanceEnvironment) {
  return {
    maintenance: {
      enabled: env.MAINTENANCE_ENABLED,
      intervalMs: env.MAINTENANCE_INTERVAL_MS,
    },
  }
}
