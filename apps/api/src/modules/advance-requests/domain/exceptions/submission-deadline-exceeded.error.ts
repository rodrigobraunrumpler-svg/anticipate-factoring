import { ServiceUnavailableError } from '#/common/exceptions/index.js'

/** Segundos que se piden esperar antes de reintentar un envío que venció (`Retry-After`). */
export const SUBMISSION_RETRY_AFTER_SECONDS = 30

/**
 * El envío no terminó dentro de `SUBMISSION_TIMEOUT_MS` (D57): 503 `SERVICE_UNAVAILABLE` con
 * `Retry-After`. Lo subido ya se liberó y se borró. Si venció durante la transacción, pudo confirmar
 * igual: el reintento con la misma `Idempotency-Key` recibe la solicitud guardada. La etapa en que
 * venció queda solo en el diagnóstico, para el log.
 */
export class SubmissionDeadlineExceededError extends ServiceUnavailableError {
  constructor(timeoutMs: number, stage: string) {
    super(`el envío no terminó en ${timeoutMs} ms (SUBMISSION_TIMEOUT_MS), durante: ${stage}`, {
      retryAfterSeconds: SUBMISSION_RETRY_AFTER_SECONDS,
    })
  }
}
