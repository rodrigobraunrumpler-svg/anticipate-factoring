import type { Prisma } from '#/infrastructure/prisma/generated/client.js'
import { type NewOutboxMessage, outboxMessageProblem } from '#/modules/outbox/index.js'
import { toOutboxInsertRecord } from './mappers/outbox-event-row.mapper.js'

/** Sirve el `tx` de una transacción interactiva o el cliente entero. */
export type OutboxWriter = Pick<Prisma.TransactionClient, '$executeRaw'>

/**
 * Encola los mensajes en UNA sentencia, dentro de la transacción del agregado: si esa transacción se
 * revierte, no queda ninguno. `available_at`, `created_at` y `updated_at` los pone la base con `now()`
 * (un `createMany` los manda con el reloj de la API, porque Prisma calcula `@default(now())`;
 * comprobado), `uuidv7()` da el id y `ON CONFLICT (dedupe_key) DO NOTHING` descarta lo ya encolado.
 * Un mensaje mal formado es un error de programación: lanza antes de escribir. Devuelve las filas nuevas.
 */
export async function insertOutboxMessages(
  tx: OutboxWriter,
  messages: readonly NewOutboxMessage[],
  options: { maxAttempts: number },
): Promise<number> {
  if (messages.length === 0) return 0
  for (const message of messages) {
    const problem = outboxMessageProblem(message)
    if (problem !== null)
      throw new Error(`Mensaje de outbox inválido (${message.handler}): ${problem}`)
  }
  const records = JSON.stringify(messages.map(toOutboxInsertRecord))
  return tx.$executeRaw`
    INSERT INTO outbox_events
      (handler, dedupe_key, event_type, payload, advance_request_id, correlation_id, max_attempts)
    SELECT m.handler, m.dedupe_key, m.event_type, m.payload, m.advance_request_id, m.correlation_id,
           ${options.maxAttempts}::int
      FROM jsonb_to_recordset(${records}::jsonb) AS m(
             handler text, dedupe_key text, event_type text, payload jsonb,
             advance_request_id uuid, correlation_id text)
    ON CONFLICT (dedupe_key) DO NOTHING`
}
