import { describe, expect, it, vi } from 'vitest'
import { abortable } from './abortable.js'

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('abortable', () => {
  it('sin señal espera el trabajo tal cual', async () => {
    await expect(abortable(undefined, async () => 'listo')).resolves.toBe('listo')
  })

  it('resuelve con el trabajo si termina antes, y suelta el oyente de la señal', async () => {
    const controller = new AbortController()
    const removed = vi.spyOn(controller.signal, 'removeEventListener')
    await expect(abortable(controller.signal, async () => 'listo')).resolves.toBe('listo')
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('al cancelarse rechaza en el acto con el motivo, aunque el trabajo siga en curso', async () => {
    const controller = new AbortController()
    const work = deferred<string>()
    const waiting = abortable(controller.signal, () => work.promise)
    const reason = new Error('plazo del envío')
    controller.abort(reason)
    await expect(waiting).rejects.toBe(reason)
    // El trabajo que termina después no cambia nada.
    work.resolve('tarde')
    await tick()
  })

  it('con la señal ya cancelada rechaza sin llamar al trabajo', async () => {
    const controller = new AbortController()
    const reason = new Error('ya vencido')
    controller.abort(reason)
    const work = vi.fn(async () => 'no')
    await expect(abortable(controller.signal, work)).rejects.toBe(reason)
    expect(work).not.toHaveBeenCalled()
  })

  it('el rechazo tardío del trabajo queda atendido: no es un rechazo sin atender del proceso', async () => {
    const controller = new AbortController()
    const work = deferred<string>()
    const waiting = abortable(controller.signal, () => work.promise)
    controller.abort(new Error('plazo'))
    await expect(waiting).rejects.toThrow('plazo')
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      work.reject(new Error('la base respondió tarde'))
      await tick()
      await tick()
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('una excepción síncrona del trabajo llega como promesa rechazada', async () => {
    const failure = new Error('síncrona')
    const controller = new AbortController()
    let result: Promise<unknown> | undefined
    expect(() => {
      result = abortable(controller.signal, () => {
        throw failure
      })
    }).not.toThrow()
    await expect(result).rejects.toBe(failure)
  })
})
