/**
 * Corre `operation` con un plazo propio. Le pasa una señal que se cancela a los `timeoutMs` y, en ese
 * mismo momento, rechaza con `timeoutError()` aunque la operación no atienda la señal: el SDK solo la
 * mira al empezar cada intento, no mientras espera entre uno y otro (hasta 20 s, o lo que pida un
 * `Retry-After`). Lo que la operación haga después ya no cambia el resultado. El temporizador es
 * propio y no `AbortSignal.timeout`: se limpia al terminar en vez de quedar pendiente hasta vencer.
 */
export function withDeadline<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutError: () => Error,
): Promise<T> {
  const controller = new AbortController()
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Primero el rechazo: gana aunque la operación rechace en cuanto ve la señal.
      reject(timeoutError())
      controller.abort()
    }, timeoutMs)
    // `async` convierte una excepción síncrona de la operación en promesa rechazada.
    const pending = (async () => operation(controller.signal))()
    pending.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}
