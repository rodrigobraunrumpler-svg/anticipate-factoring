import { describe, expect, it, vi } from 'vitest'
import { withDeadline } from './deadline.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const timeoutError = () => Object.assign(new Error('venció el plazo'), { name: 'TimeoutError' })

describe('withDeadline con la señal de quien llama', () => {
  it('ya cancelada: rechaza con su motivo sin empezar la operación', async () => {
    const controller = new AbortController()
    const reason = new Error('plazo del envío')
    controller.abort(reason)
    let started = false
    await expect(
      withDeadline(
        1_000,
        async () => {
          started = true
        },
        timeoutError,
        controller.signal,
      ),
    ).rejects.toBe(reason)
    expect(started).toBe(false)
  })

  it('cancelada en curso: rechaza en el acto con su motivo y cancela la señal de la operación', async () => {
    const controller = new AbortController()
    let received: AbortSignal | undefined
    const running = withDeadline(
      10_000,
      (signal) => {
        received = signal
        return new Promise(() => undefined)
      },
      timeoutError,
      controller.signal,
    )
    await sleep(10)
    const reason = new Error('plazo del envío')
    const startedAt = Date.now()
    controller.abort(reason)
    await expect(running).rejects.toBe(reason)
    expect(Date.now() - startedAt).toBeLessThan(50)
    expect(received?.aborted).toBe(true)
  })

  it('terminada a tiempo: suelta el oyente de la señal de quien llama', async () => {
    const controller = new AbortController()
    const removed = vi.spyOn(controller.signal, 'removeEventListener')
    await expect(
      withDeadline(1_000, async () => 'listo', timeoutError, controller.signal),
    ).resolves.toBe('listo')
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})

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
