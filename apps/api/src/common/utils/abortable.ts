/**
 * Espera `work()` salvo que `signal` se cancele antes: entonces rechaza en el acto con
 * `signal.reason`. Con la señal ya cancelada, rechaza sin llamar a `work`. Sirve para esperar lo que
 * no se puede cancelar (una consulta de Prisma ya enviada): lo que `work` haga después ya no cambia el
 * resultado, y su rechazo tardío queda atendido (nunca es un rechazo sin atender del proceso). Sin
 * señal, es `work()` tal cual. Una excepción síncrona de `work` llega como promesa rechazada.
 */
export function abortable<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  const pending = (async () => work())()
  if (signal === undefined) return pending
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}
