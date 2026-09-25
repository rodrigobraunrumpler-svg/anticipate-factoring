import type { Clock } from '#/common/time/clock.js'

/** El reloj del proceso. En los tests `CLOCK` se reemplaza por un reloj fijo o manejable. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date()
  }
}
