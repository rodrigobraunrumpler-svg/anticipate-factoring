import { z } from 'zod'
import { integer } from './env-values.js'
import type { OutboxEnvironment } from './outbox.schema.js'

/**
 * Lo que el apagado deja después del tope de un handler del outbox: registrar el resultado del correo
 * que se estaba enviando y cerrar la base y el almacenamiento.
 */
export const SHUTDOWN_MARGIN_AFTER_OUTBOX_HANDLER_MS = 2_000

/**
 * Plazos de vida del proceso. `SHUTDOWN_TIMEOUT_MS` es el tope del apagado, desde la señal hasta la
 * salida: el servidor deja de aceptar conexiones, cierra las ociosas, responde lo que está en curso
 * con `Connection: close` y espera a los workers; pasado el plazo corta lo que queda y sale con
 * código 1 (D56). Queda por debajo del período de gracia del orquestador (`stop_grace_period`: 30 s en
 * Compose), que después manda SIGKILL.
 */
export const deadlinesShape = {
  SHUTDOWN_TIMEOUT_MS: integer({ fallback: 25_000, min: 1_000, max: 600_000 }),
}

const deadlinesSchema = z.object(deadlinesShape)
export type DeadlinesEnvironment = z.output<typeof deadlinesSchema>

export function refineDeadlines(
  env: DeadlinesEnvironment & Pick<OutboxEnvironment, 'OUTBOX_HANDLER_TIMEOUT_MS'>,
  ctx: z.RefinementCtx,
): void {
  // Al apagar, el publicador termina el correo en curso (hasta OUTBOX_HANDLER_TIMEOUT_MS) y registra
  // su resultado. Cortado antes, el arriendo vence y otra réplica lo reenvía: el proveedor recibiría
  // el correo dos veces.
  if (
    env.SHUTDOWN_TIMEOUT_MS <
    env.OUTBOX_HANDLER_TIMEOUT_MS + SHUTDOWN_MARGIN_AFTER_OUTBOX_HANDLER_MS
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['SHUTDOWN_TIMEOUT_MS'],
      message: `debe ser al menos OUTBOX_HANDLER_TIMEOUT_MS + ${SHUTDOWN_MARGIN_AFTER_OUTBOX_HANDLER_MS}: el correo que se está enviando al apagar termina y registra su resultado antes del cierre forzado`,
    })
  }
}

export function toDeadlinesConfig(env: DeadlinesEnvironment) {
  return {
    shutdown: { timeoutMs: env.SHUTDOWN_TIMEOUT_MS },
  }
}
