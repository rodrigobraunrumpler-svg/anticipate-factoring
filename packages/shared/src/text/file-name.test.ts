import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { isFileName, MAX_FILE_NAME_LENGTH } from './file-name.js'

/** Referencia independiente: un control de Unicode (Cc), un sustituto o U+FFFE/U+FFFF no van. */
const allowedInName = (cp: number): boolean =>
  !(cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) &&
  !(cp >= 0xd800 && cp <= 0xdfff) &&
  cp !== 0xfffe &&
  cp !== 0xffff

/** Bytes UTF-8 del nombre escrito como cadena JSON, comillas incluidas. */
const jsonBytes = (name: string): number => new TextEncoder().encode(JSON.stringify(name)).length

describe('MAX_FILE_NAME_LENGTH', () => {
  it('es el tope de los sistemas de archivos: 255 unidades UTF-16', () => {
    expect(MAX_FILE_NAME_LENGTH).toBe(255)
  })
})

describe('isFileName', () => {
  it.each([
    'F001-123.xml',
    'f001-123.PDF',
    'Factura ñandú (1).pdf',
    '50%.pdf',
    'comillas "dobles" y \\ barra.xml',
    '😀 factura.xml',
    ' espacios alrededor .xml',
    'byte inválido \uFFFD.pdf',
    '\u2028 separador de línea.xml',
    '.xml',
  ])('acepta un nombre que produce un sistema de archivos: %j', (name) => {
    expect(isFileName(name)).toBe(true)
  })

  it('acepta hasta 255 unidades UTF-16 y rechaza desde 256, como cuenta String.length', () => {
    expect(isFileName('a'.repeat(255))).toBe(true)
    expect(isFileName('a'.repeat(256))).toBe(false)
    expect(isFileName('ñ'.repeat(255))).toBe(true)
    expect(isFileName('請'.repeat(256))).toBe(false)
    // Un emoji fuera del plano básico son dos unidades.
    expect(isFileName(`${'😀'.repeat(127)}a`)).toBe(true)
    expect(isFileName('😀'.repeat(128))).toBe(false)
    expect(isFileName('x'.repeat(16_000))).toBe(false)
  })

  it('rechaza el nombre vacío', () => {
    expect(isFileName('')).toBe(false)
  })

  it.each([
    ['U+0000', '\u0000'],
    ['U+0001', '\u0001'],
    ['tabulación', '\t'],
    ['salto de línea', '\n'],
    ['retorno de carro', '\r'],
    ['U+001F', '\u001F'],
    ['DEL', '\u007F'],
    ['el primer control C1', '\u0080'],
    ['el último control C1', '\u009F'],
    ['un sustituto alto suelto', '\uD800'],
    ['un sustituto bajo suelto', '\uDFFF'],
    ['U+FFFE', '\uFFFE'],
    ['U+FFFF', '\uFFFF'],
  ])('rechaza un nombre con %s', (_, char) => {
    expect(isFileName(`factura${char}.xml`)).toBe(false)
    expect(isFileName(char)).toBe(false)
  })

  it('coincide con la referencia en todo Unicode', () => {
    const mismatches: number[] = []
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (isFileName(`a${String.fromCodePoint(cp)}b`) !== allowedInName(cp)) mismatches.push(cp)
    }
    expect(mismatches).toEqual([])
  })

  it('un nombre aceptado ocupa en JSON como mucho 3 bytes por unidad, más las comillas', () => {
    const bound = 2 + 3 * MAX_FILE_NAME_LENGTH
    // El peor caso: 255 caracteres de 3 bytes. Las comillas y la barra se escapan con 2.
    expect(jsonBytes('請'.repeat(255))).toBe(bound)
    expect(jsonBytes('"'.repeat(255))).toBe(2 + 2 * 255)
    const hostile = fc.oneof(
      fc.constantFrom('"', '\\', '\u0000', '\u001F', '\u0085', '\uD800', '\uDC00', '請', '😀', 'a'),
      fc.string({ unit: 'binary', minLength: 1, maxLength: 1 }),
    )
    fc.assert(
      fc.property(fc.string({ unit: hostile, maxLength: 300 }), (name) => {
        if (isFileName(name)) expect(jsonBytes(name)).toBeLessThanOrEqual(bound)
      }),
      { numRuns: 500 },
    )
  })
})
