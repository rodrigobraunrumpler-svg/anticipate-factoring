/**
 * Despierta al publicador apenas se confirma una transacción que encoló eventos, sin esperar al
 * próximo sondeo. `notify()` nunca lanza: lo llama un caso de uso después del commit, cuando la
 * respuesta al usuario ya no puede cambiar.
 */
export class OutboxWakeUpSignal {
  private readonly listeners = new Set<() => void>()

  notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // Un suscriptor que falla no afecta a los demás ni a quien notifica.
      }
    }
  }

  /** Devuelve la función que cancela la suscripción. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

export const OUTBOX_WAKE_UP = Symbol('OUTBOX_WAKE_UP')
