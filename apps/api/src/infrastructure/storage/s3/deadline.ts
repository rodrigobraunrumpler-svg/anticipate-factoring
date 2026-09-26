/**
 * Corre `operation` con un plazo propio. Le pasa una señal que se cancela a los `timeoutMs` y, en ese
 * mismo momento, rechaza con `timeoutError()` aunque la operación no atienda la señal: el SDK solo la
 * mira al empezar cada intento, no mientras espera entre uno y otro (hasta 20 s, o lo que pida un
 * `Retry-After`). Lo que la operación haga después ya no cambia el resultado. El temporizador es
 * propio y no `AbortSignal.timeout`: se limpia al terminar en vez de quedar pendiente hasta vencer.
 *
 * `callerSignal` es la cancelación de quien llama (el plazo de un envío): si ya está cancelada, rechaza
 * con su motivo sin empezar; si se cancela en curso, rechaza en el acto con su motivo y cancela
 * también la señal de la operación.
 */
export function withDeadline<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutError: () => Error,
  callerSignal?: AbortSignal,
): Promise<T> {
  if (callerSignal?.aborted) return Promise.reject(callerSignal.reason)
  const controller = new AbortController()
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Primero el rechazo: gana aunque la operación rechace en cuanto ve la señal.
      reject(timeoutError())
      controller.abort()
    }, timeoutMs)
    const onCallerAbort = () => {
      reject(callerSignal?.reason)
      controller.abort()
    }
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
    // `async` convierte una excepción síncrona de la operación en promesa rechazada.
    const pending = (async () => operation(controller.signal))()
    pending.then(resolve, reject).finally(() => {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', onCallerAbort)
    })
  })
}
