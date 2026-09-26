import { describe, expect, it } from 'vitest'
import { isXmlCodePoint, isXmlText } from './xml-text.js'

/** La producción `Char` de XML 1.0 (§2.2), escrita aparte como referencia independiente. */
const inCharProduction = (cp: number): boolean =>
  cp === 0x9 ||
  cp === 0xa ||
  cp === 0xd ||
  (cp >= 0x20 && cp <= 0xd7ff) ||
  (cp >= 0xe000 && cp <= 0xfffd) ||
  (cp >= 0x10000 && cp <= 0x10ffff)

describe('isXmlCodePoint', () => {
  it('coincide con la producción Char de XML 1.0 en todo Unicode', () => {
    const mismatches: number[] = []
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (isXmlCodePoint(cp) !== inCharProduction(cp)) mismatches.push(cp)
    }
    expect(mismatches).toEqual([])
  })

  it.each([
    [0x0, false],
    [0x8, false],
    [0x9, true],
    [0xa, true],
    [0xb, false],
    [0xd, true],
    [0x1f, false],
    [0x20, true],
    [0xd800, false],
    [0xdfff, false],
    [0xfffd, true],
    [0xfffe, false],
    [0xffff, false],
    [0x1f600, true],
  ])('U+%s → %s', (cp, expected) => {
    expect(isXmlCodePoint(cp)).toBe(expected)
  })

  it('rechaza lo que no es un punto de código', () => {
    for (const value of [-1, 0x110000, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isXmlCodePoint(value)).toBe(false)
    }
  })
})

describe('isXmlText', () => {
  it('acepta texto con tildes, tabulación, saltos de línea y caracteres fuera del plano básico', () => {
    expect(isXmlText('')).toBe(true)
    expect(isXmlText('CASTAÑEDA\tS.A.C.\r\n😀 \uE000 \uFFFD')).toBe(true)
  })

  it.each([
    ['U+0000', 'PROV\u0000EEDOR'],
    ['un control C0', 'A\u0001B'],
    ['U+001F', 'A\u001FB'],
    ['U+FFFE', 'A\uFFFEB'],
    ['U+FFFF', 'A\uFFFFB'],
    ['un sustituto alto suelto', 'A\uD800B'],
    ['un sustituto bajo suelto', 'A\uDC00B'],
  ])('rechaza %s', (_, text) => {
    expect(isXmlText(text)).toBe(false)
  })

  it('un par de sustitutos bien formado es un solo carácter válido', () => {
    expect(isXmlText('\uD83D\uDE00')).toBe(true)
  })
})
