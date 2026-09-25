import { describe, expect, it } from 'vitest'
import { withDeadline } from './deadline.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const timeoutError = () => Object.assign(new Error('venció el plazo'), { name: 'TimeoutError' })

describe('withDeadline', () => {
  it('resuelve con lo que devuelve la operación y no cancela la señal al terminar a tiempo', async () => {
    let received: AbortSignal | undefined
    const result = await withDeadline(
      50,
      async (signal) => {
        received = signal
        return 'listo'
      },
      timeoutError,
    )

    expect(result).toBe('listo')
    // Pasado el plazo, la señal sigue sin cancelar: el temporizador se limpió al terminar.
    await sleep(80)
    expect(received?.aborted).toBe(false)
  })

  it('rechaza con el error de la operación si falla antes del plazo', async () => {
    const failure = new Error('rechazada')
    await expect(withDeadline(1_000, () => Promise.reject(failure), timeoutError)).rejects.toBe(
      failure,
    )
  })

  it('una excepción síncrona de la operación llega como promesa rechazada', async () => {
    const failure = new Error('síncrona')
    let result: Promise<unknown> | undefined
    expect(() => {
      result = withDeadline(
        1_000,
        () => {
          throw failure
        },
        timeoutError,
      )
    }).not.toThrow()
    await expect(result).rejects.toBe(failure)
  })

  it('al vencer rechaza enseguida aunque la operación no atienda la señal, y la cancela', async () => {
    let received: AbortSignal | undefined
    const startedAt = Date.now()

    await expect(
      withDeadline(
        50,
        (signal) => {
          received = signal
          // Como el SDK entre dos intentos: espera sin mirar la señal.
          return sleep(2_000).then(() => 'tarde')
        },
        timeoutError,
      ),
    ).rejects.toMatchObject({ name: 'TimeoutError', message: 'venció el plazo' })
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(received?.aborted).toBe(true)
  })

  it('el rechazo tardío de la operación, ya vencido el plazo, no cambia el resultado', async () => {
    await expect(
      withDeadline(
        20,
        (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('AbortError del SDK')))
          }),
        timeoutError,
      ),
    ).rejects.toMatchObject({ name: 'TimeoutError' })
  })
})
