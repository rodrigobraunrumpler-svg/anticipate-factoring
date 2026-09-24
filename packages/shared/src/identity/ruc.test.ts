import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { isValidRuc, rucSchema } from './ruc.js'

describe('isValidRuc', () => {
  it.each([
    ['20100070970', 'empresa (prefijo 20)'],
    ['20131312955', 'entidad pública (prefijo 20)'],
    ['10467286736', 'persona natural con negocio (prefijo 10)'],
  ])('acepta %s (%s)', (ruc) => {
    expect(isValidRuc(ruc)).toBe(true)
  })

  it.each([
    ['20100070971', 'dígito verificador incorrecto'],
    ['12345678901', 'prefijo no válido'],
    ['2010007097', 'diez dígitos'],
    ['201000709700', 'doce dígitos'],
    ['2010007097A', 'con letra'],
    ['', 'vacío'],
  ])('rechaza %s (%s)', (ruc) => {
    expect(isValidRuc(ruc)).toBe(false)
  })
})

describe('isValidRuc · propiedades', () => {
  it('para cualquier cuerpo de diez dígitos con prefijo válido existe exactamente un dígito verificador', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('10', '15', '16', '17', '20'),
        fc.stringMatching(/^\d{8}$/),
        (prefix, body) => {
          const valid = [...'0123456789'].filter((d) => isValidRuc(`${prefix}${body}${d}`))
          return valid.length === 1
        },
      ),
    )
  })

  it('nunca acepta algo que no sean once dígitos', () => {
    fc.assert(
      fc.property(fc.string(), (value) => /^\d{11}$/.test(value) || isValidRuc(value) === false),
    )
  })
})

describe('rucSchema', () => {
  it('recorta espacios y acepta un RUC válido', () => {
    expect(rucSchema.parse('  20100070970 ')).toBe('20100070970')
  })

  it('devuelve el mensaje en español cuando es inválido', () => {
    const r = rucSchema.safeParse('20100070971')
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0]?.message).toBe('El RUC no es válido.')
  })
})
