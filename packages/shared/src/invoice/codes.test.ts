import { describe, expect, it } from 'vitest'
import { DOCUMENT_TYPE_NAMES, documentTypeName } from './codes.js'
import { INVOICE_RULES } from './rules.js'

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

describe('tablas del dominio de facturas', () => {
  it('son de solo lectura en tiempo de compilación', () => {
    // Nunca se ejecuta: solo comprueba con `tsc` que las tablas no se pueden modificar.
    const mutate = () => {
      // @ts-expect-error la tabla es de solo lectura
      DOCUMENT_TYPE_NAMES['01'] = 'x'
      const [first] = INVOICE_RULES
      if (first) {
        // @ts-expect-error cada regla es de solo lectura
        first.id = 'document-type'
      }
    }
    expect(mutate).toBeTypeOf('function')
  })
})
