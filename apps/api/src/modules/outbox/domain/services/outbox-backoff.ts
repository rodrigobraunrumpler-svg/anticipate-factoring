/**
 * Espera antes del siguiente intento, en milisegundos: base × 2^(intentos − 1), con tope, más un jitter
 * de ±10 % para no sincronizar reintentos. `jitter` va de −1 a 1 (en producción, `Math.random() * 2 − 1`).
 */
export function outboxBackoff(
  attempts: number,
  options: { baseDelayMs: number; maxDelayMs: number },
  jitter: number,
): number {
  if (!Number.isInteger(attempts) || attempts < 1)
    throw new RangeError(`Intentos inválidos: ${attempts}`)
  if (!(jitter >= -1 && jitter <= 1)) throw new RangeError(`Jitter fuera de rango: ${jitter}`)
  const raw = Math.min(options.baseDelayMs * 2 ** (attempts - 1), options.maxDelayMs)
  return Math.round(raw + raw * 0.1 * jitter)
}
