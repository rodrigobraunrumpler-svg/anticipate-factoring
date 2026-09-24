import { describe, expect, it } from 'vitest'
import { formatPublicCode, parsePublicCode } from './public-code.js'

describe('código público de solicitud', () => {
  it('formatea con prefijo, año y secuencia de seis dígitos', () => {
    expect(formatPublicCode({ prefix: 'ANT', year: 2026, sequence: 123 })).toBe('ANT-2026-000123')
    expect(formatPublicCode({ prefix: 'ANT', year: 2026, sequence: 1_234_567 })).toBe(
      'ANT-2026-1234567',
    )
  })

  it('parsea y rechaza formatos ajenos', () => {
    expect(parsePublicCode('ANT-2026-000123')).toEqual({ prefix: 'ANT', year: 2026, sequence: 123 })
    expect(parsePublicCode('ant-2026-000123')).toEqual({ prefix: 'ANT', year: 2026, sequence: 123 })
    expect(parsePublicCode('2026-000123')).toBeNull()
    expect(parsePublicCode('ANT-26-1')).toBeNull()
  })
})
