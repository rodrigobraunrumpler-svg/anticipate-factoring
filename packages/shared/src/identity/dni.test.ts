import { describe, expect, it } from 'vitest'
import { dniSchema, isValidDni } from './dni.js'

describe('isValidDni', () => {
  it('acepta 8 dígitos', () => {
    expect(isValidDni('46728673')).toBe(true)
    expect(isValidDni('00000001')).toBe(true)
  })

  it.each(['4672867', '467286731', '4672867A', ''])('rechaza %s', (dni) => {
    expect(isValidDni(dni)).toBe(false)
  })
})

describe('dniSchema', () => {
  it('recorta espacios', () => {
    expect(dniSchema.parse(' 46728673 ')).toBe('46728673')
  })

  it('devuelve el mensaje en español cuando es inválido', () => {
    const r = dniSchema.safeParse('123')
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0]?.message).toBe('El DNI debe tener 8 dígitos.')
  })
})
