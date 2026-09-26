/**
 * Espera antes del siguiente intento, en milisegundos: base × 2^(intentos − 1), más un jitter de ±10 %
 * para no sincronizar reintentos, siempre dentro de [0, maxDelayMs]. Con el tope alcanzado el jitter
 * solo puede bajar la espera. `jitter` va de −1 a 1 (en producción, `Math.random() * 2 − 1`).
 */
export function outboxBackoff(
  attempts: number,
  options: { baseDelayMs: number; maxDelayMs: number },
  jitter: number,
): number {
  const { baseDelayMs, maxDelayMs } = options
  if (!Number.isInteger(attempts) || attempts < 1)
    throw new RangeError(`Intentos inválidos: ${attempts}`)
  if (!(jitter >= -1 && jitter <= 1)) throw new RangeError(`Jitter fuera de rango: ${jitter}`)
  if (!isDelay(baseDelayMs) || !isDelay(maxDelayMs))
    throw new RangeError(`Esperas inválidas: base ${baseDelayMs} ms, tope ${maxDelayMs} ms`)
  const capped = Math.min(baseDelayMs * 2 ** (attempts - 1), maxDelayMs)
  return Math.min(Math.max(Math.round(capped + capped * 0.1 * jitter), 0), maxDelayMs)
}

function isDelay(ms: number): boolean {
  return Number.isFinite(ms) && ms >= 0
}
