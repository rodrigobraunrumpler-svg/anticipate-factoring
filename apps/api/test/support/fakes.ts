import type { Clock } from '#/common/time/clock.js'

/** Reloj de prueba: queda fijo hasta que el test lo mueve. */
export class MutableClock implements Clock {
  private current: number

  constructor(start: Date) {
    this.current = start.getTime()
  }

  now(): Date {
    return new Date(this.current)
  }

  set(date: Date): void {
    this.current = date.getTime()
  }

  advance(milliseconds: number): void {
    this.current += milliseconds
  }
}
