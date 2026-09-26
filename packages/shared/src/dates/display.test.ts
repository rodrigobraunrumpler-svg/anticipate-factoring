import { describe, expect, it } from 'vitest'
import { formatDateTimeIn, formatIsoDate } from './display.js'
import { type IsoDate, LIMA_TIME_ZONE } from './iso-date.js'

describe('formatIsoDate', () => {
  it('escribe una fecha de calendario como se lee en Perú, sin tocar la zona horaria', () => {
    expect(formatIsoDate('2026-11-30')).toBe('30/11/2026')
    // El año con ceros a la izquierda no cabe en el tipo (`${bigint}`), pero es una IsoDate válida.
    expect(formatIsoDate('0001-01-01' as IsoDate)).toBe('01/01/0001')
  })

  it.each(['2026-02-30', '30/11/2026', ''])('una fecha inválida (%s) lanza', (value) => {
    expect(() => formatIsoDate(value as IsoDate)).toThrow()
  })
})

describe('formatDateTimeIn', () => {
  it('escribe el instante con la fecha y la hora de 24 h de la zona pedida', () => {
    const instant = new Date('2026-09-24T15:00:00.000Z')
    expect(formatDateTimeIn(LIMA_TIME_ZONE, instant)).toBe('24/09/2026 10:00')
    expect(formatDateTimeIn('UTC', instant)).toBe('24/09/2026 15:00')
  })

  it('pasada la medianoche UTC, en Lima todavía es el día anterior', () => {
    expect(formatDateTimeIn(LIMA_TIME_ZONE, new Date('2026-09-25T04:30:00.000Z'))).toBe(
      '24/09/2026 23:30',
    )
  })

  it('un instante inválido lanza en vez de escribir «Invalid Date»', () => {
    expect(() => formatDateTimeIn(LIMA_TIME_ZONE, new Date(Number.NaN))).toThrow(RangeError)
  })
})
