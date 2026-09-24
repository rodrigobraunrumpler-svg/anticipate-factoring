import { describe, expect, it } from 'vitest'
import { documentTypeName } from './codes.js'

describe('documentTypeName', () => {
  it('devuelve el nombre en español para un código conocido', () => {
    expect(documentTypeName('01')).toBe('factura')
  })

  it('no expone propiedades heredadas del objeto para un código desconocido', () => {
    expect(documentTypeName('constructor')).toBe('constructor')
  })

  it('devuelve el código tal cual si no está en el catálogo', () => {
    expect(documentTypeName('99')).toBe('99')
  })
})
