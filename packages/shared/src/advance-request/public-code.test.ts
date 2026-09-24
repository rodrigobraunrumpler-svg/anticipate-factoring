import { describe, expect, it } from 'vitest'
import { VALIDATION_MESSAGES_ES } from '../errors/index.js'
import { formatPublicCode, parsePublicCode, publicCodeSchema } from './public-code.js'

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

  it('parsea una secuencia de hasta 15 dígitos sin perder precisión y rechaza una más larga', () => {
    expect(parsePublicCode('ANT-2026-999999999999999')?.sequence).toBe(999_999_999_999_999)
    expect(parsePublicCode('ANT-2026-1234567890123456')).toBeNull()
  })
})

describe('publicCodeSchema', () => {
  it('acepta un código válido y lo devuelve canónico en mayúsculas', () => {
    expect(publicCodeSchema.parse(' ant-2026-000123 ')).toBe('ANT-2026-000123')
  })

  it('rechaza formatos ajenos con mensaje en español', () => {
    for (const code of ['2026-000123', 'ANT-26-1', 'ANT-2026-12345']) {
      const r = publicCodeSchema.safeParse(code)
      expect(r.success, code).toBe(false)
      if (!r.success) {
        expect(r.error.issues[0]?.message).toBe(VALIDATION_MESSAGES_ES.advanceRequest.publicCode)
      }
    }
  })
})
