import { describe, expect, it } from 'vitest'
import {
  addDaysIso,
  daysBetween,
  isIsoDate,
  isoDateSchema,
  LIMA_TIME_ZONE,
  todayIn,
} from './iso-date.js'

describe('isIsoDate', () => {
  it.each(['2026-09-23', '2024-02-29'])('acepta %s', (v) => {
    expect(isIsoDate(v)).toBe(true)
  })

  it.each(['2026-9-3', '23/09/2026', '2026-13-01', '2023-02-29', '2026-09-23T00:00:00Z', ''])(
    'rechaza %s',
    (v) => {
      expect(isIsoDate(v)).toBe(false)
    },
  )
})

describe('daysBetween', () => {
  it('cuenta días de calendario', () => {
    expect(daysBetween('2026-09-23', '2026-09-23')).toBe(0)
    expect(daysBetween('2026-09-23', '2026-10-08')).toBe(15)
    expect(daysBetween('2026-09-23', '2026-09-22')).toBe(-1)
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1)
  })

  it('lanza si una fecha es inválida', () => {
    expect(() => daysBetween('2026-09-23', '2026-13-01')).toThrow()
  })
})

describe('addDaysIso', () => {
  it('suma días de calendario cruzando mes y año', () => {
    expect(addDaysIso('2026-09-01', 90)).toBe('2026-11-30')
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01')
  })
})

describe('todayIn', () => {
  it('devuelve la fecha de calendario de Lima para un instante dado', () => {
    // 2026-09-24T03:30:00Z es 2026-09-23 22:30 en Lima (UTC-5, sin horario de verano)
    expect(todayIn(LIMA_TIME_ZONE, new Date('2026-09-24T03:30:00Z'))).toBe('2026-09-23')
    expect(todayIn(LIMA_TIME_ZONE, new Date('2026-09-24T05:00:00Z'))).toBe('2026-09-24')
    expect(todayIn('UTC', new Date('2026-09-24T03:30:00Z'))).toBe('2026-09-24')
  })
})

describe('isoDateSchema', () => {
  it('rechaza con mensaje en español', () => {
    const r = isoDateSchema.safeParse('23/09/2026')
    expect(r.success).toBe(false)
    if (!r.success)
      expect(r.error.issues[0]?.message).toBe('La fecha debe tener el formato AAAA-MM-DD.')
  })
})
