import { describe, expect, it, vi } from 'vitest'
import { OutboxWakeUpSignal } from './outbox-wake-up.signal.js'

describe('OutboxWakeUpSignal', () => {
  it('avisa a cada suscriptor hasta que cancela su suscripción', () => {
    const signal = new OutboxWakeUpSignal()
    const listener = vi.fn()
    const unsubscribe = signal.subscribe(listener)
    signal.notify()
    unsubscribe()
    signal.notify()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('un suscriptor que lanza no afecta a los demás ni a quien notifica', () => {
    const signal = new OutboxWakeUpSignal()
    const healthy = vi.fn()
    signal.subscribe(() => {
      throw new Error('falla')
    })
    signal.subscribe(healthy)
    expect(() => signal.notify()).not.toThrow()
    expect(healthy).toHaveBeenCalledTimes(1)
  })
})
