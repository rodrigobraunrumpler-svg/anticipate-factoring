/** Token del presupuesto de cuerpos en memoria del proceso (`InflightBodyBudgetModule`). */
export const INFLIGHT_BODY_BUDGET = Symbol('INFLIGHT_BODY_BUDGET')

function assertByteCount(name: string, value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} debe ser un entero de al menos ${minimum}; llegó ${value}`)
  }
}

/**
 * Bytes de cuerpos que el proceso tiene leídos en memoria a la vez (`UPLOAD_MAX_INFLIGHT_BYTES`).
 * multer lee cada envío entero en memoria: sin este tope, unos pocos envíos grandes simultáneos, cada
 * uno dentro de `UPLOAD_MAX_BODY_BYTES`, sumarían gigas y tumbarían el proceso para todos. La reserva
 * es por el `Content-Length` declarado, antes de leer un byte: Node nunca entrega más cuerpo que ese.
 * Es de un solo proceso y en memoria; cada réplica tiene el suyo.
 */
export class InflightBodyBudget {
  private reserved = 0

  constructor(readonly maxBytes: number) {
    assertByteCount('El presupuesto de cuerpos en memoria', maxBytes, 1)
  }

  get reservedBytes(): number {
    return this.reserved
  }

  /**
   * Reserva `bytes` si caben. Devuelve la función que los libera (llamarla más de una vez no hace
   * nada) o `null` si no caben: con lo ya reservado se pasaría del tope.
   */
  tryReserve(bytes: number): (() => void) | null {
    assertByteCount('El tamaño a reservar', bytes, 0)
    if (this.reserved + bytes > this.maxBytes) return null
    this.reserved += bytes
    let released = false
    return () => {
      if (released) return
      released = true
      this.reserved -= bytes
    }
  }
}
