import { z } from 'zod'
import { integer } from './env-values.js'
import type { OutboxEnvironment } from './outbox.schema.js'

/**
 * Lo que el apagado deja después del tope de un handler del outbox: registrar el resultado del correo
 * que se estaba enviando y cerrar la base y el almacenamiento.
 */
export const SHUTDOWN_MARGIN_AFTER_OUTBOX_HANDLER_MS = 2_000

/**
 * Tope de la limpieza de un envío que falló o venció: liberar sus filas y borrar lo que subió. Pasado,
 * la respuesta sale igual y lo que falte lo terminan la purga y el barrido de huérfanos.
 */
export const SUBMISSION_CLEANUP_TIMEOUT_MS = 10_000

/** Cloudflare corta al cliente (524) si el origen no empieza a responder en 100 s. */
export const PROXY_RESPONSE_TIMEOUT_MS = 100_000

/** Margen entre la respuesta más tardía de un envío y el corte de Cloudflare. */
const PROXY_RESPONSE_MARGIN_MS = 10_000

/** El plazo más largo con el que la respuesta, limpieza incluida, sale antes del corte de Cloudflare. */
export const MAX_SUBMISSION_TIMEOUT_MS =
  PROXY_RESPONSE_TIMEOUT_MS - SUBMISSION_CLEANUP_TIMEOUT_MS - PROXY_RESPONSE_MARGIN_MS

/**
 * Plazos de vida. `SUBMISSION_TIMEOUT_MS` es el tope de un envío de solicitud, desde que el caso de uso
 * empieza (el cuerpo ya se leyó) hasta la respuesta: al vencer, lo que el envío espera se corta, lo
 * subido se libera y se borra (con su propio tope, `SUBMISSION_CLEANUP_TIMEOUT_MS`) y responde 503
 * con `Retry-After` (D57). No se compara con `SERVER_REQUEST_TIMEOUT_MS`: ese cubre solo la llegada de
 * la petición, una etapa anterior. `SHUTDOWN_TIMEOUT_MS` es el tope del apagado, desde la señal hasta
 * la salida: el servidor deja de aceptar conexiones, cierra las ociosas, responde lo que está en curso
 * con `Connection: close` y espera a los workers; pasado el plazo corta lo que queda y sale con
 * código 1 (D56). Queda por debajo del período de gracia del orquestador (`stop_grace_period`: 30 s en
 * Compose), que después manda SIGKILL.
 */
export const deadlinesShape = {
  SUBMISSION_TIMEOUT_MS: integer({ fallback: 60_000, min: 1_000, max: 3_600_000 }),
  SHUTDOWN_TIMEOUT_MS: integer({ fallback: 25_000, min: 1_000, max: 600_000 }),
}

const deadlinesSchema = z.object(deadlinesShape)
export type DeadlinesEnvironment = z.output<typeof deadlinesSchema>

export function refineDeadlines(
  env: DeadlinesEnvironment & Pick<OutboxEnvironment, 'OUTBOX_HANDLER_TIMEOUT_MS'>,
  ctx: z.RefinementCtx,
): void {
  // La respuesta de un envío vencido sale después de su limpieza: las dos juntas, antes del corte del
  // proxy. Si no, el proveedor recibe el 524 de Cloudflare y no el 503 con Retry-After.
  if (env.SUBMISSION_TIMEOUT_MS > MAX_SUBMISSION_TIMEOUT_MS) {
    ctx.addIssue({
      code: 'custom',
      path: ['SUBMISSION_TIMEOUT_MS'],
      message: `debe ser como máximo ${MAX_SUBMISSION_TIMEOUT_MS}: con la limpieza (hasta ${SUBMISSION_CLEANUP_TIMEOUT_MS} ms) y un margen de ${PROXY_RESPONSE_MARGIN_MS} ms, la respuesta sale antes de los ${PROXY_RESPONSE_TIMEOUT_MS} ms en que Cloudflare corta al cliente (docs/STACK.md, sección 12)`,
    })
  }
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
    submission: {
      timeoutMs: env.SUBMISSION_TIMEOUT_MS,
      cleanupTimeoutMs: SUBMISSION_CLEANUP_TIMEOUT_MS,
    },
    shutdown: { timeoutMs: env.SHUTDOWN_TIMEOUT_MS },
  }
}
