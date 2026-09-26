import { problemSchema } from '@anticipate/shared/errors'
import { isFileName } from '@anticipate/shared/text'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { UploadedFile } from '../types/invoice-intake.types.js'
import { displayFileName, screenFileNames } from './file-names.js'

const file = (originalname: string): UploadedFile => {
  const buffer = Buffer.from('contenido')
  return { originalname, buffer, size: buffer.length }
}

describe('displayFileName', () => {
  it('muestra tal cual un nombre corto sin caracteres raros', () => {
    expect(displayFileName('F001-123.xml')).toBe('F001-123.xml')
    expect(displayFileName('x'.repeat(64))).toBe('x'.repeat(64))
  })

  it('muestra los primeros 64 puntos de código y «…» si hay más, sin partir un emoji', () => {
    expect(displayFileName('x'.repeat(65))).toBe(`${'x'.repeat(64)}…`)
    expect(displayFileName('x'.repeat(16_000))).toBe(`${'x'.repeat(64)}…`)
    expect(displayFileName('😀'.repeat(65))).toBe(`${'😀'.repeat(64)}…`)
  })

  it('cambia por U+FFFD cada control y cada carácter que XML no admite', () => {
    expect(displayFileName('a\u0000b\tc\u0085d\uD800e\uFFFEf\n.xml')).toBe(
      'a\uFFFDb\uFFFDc\uFFFDd\uFFFDe\uFFFDf\uFFFD.xml',
    )
  })

  it('lo que muestra siempre es un nombre de archivo corto, salvo el de un nombre vacío', () => {
    expect(displayFileName('')).toBe('')
    const hostile = fc.oneof(
      fc.constantFrom('\u0000', '\n', '\u0085', '\uD800', '\uDFFF', '\uFFFF', '😀', '"', 'a'),
      fc.string({ unit: 'binary', minLength: 1, maxLength: 1 }),
    )
    fc.assert(
      fc.property(fc.string({ unit: hostile, minLength: 1, maxLength: 400 }), (name) => {
        const shown = displayFileName(name)
        expect(isFileName(shown)).toBe(true)
        expect([...shown].length).toBeLessThanOrEqual(65)
      }),
      { numRuns: 500 },
    )
  })
})

describe('screenFileNames', () => {
  it('deja pasar los archivos con un nombre de archivo, en orden y por identidad', () => {
    const files = [file('F001-2.xml'), file('Factura ñandú (1).xml'), file('a'.repeat(255))]
    expect(screenFileNames(files)).toEqual({ accepted: files, problems: [] })
    expect(screenFileNames(files).accepted[0]).toBe(files[0])
  })

  it('un nombre sin tope es INVALID_FILE_NAME con el nombre acortado, nunca entero', () => {
    const long = file(`${'x'.repeat(16_000)}.xml`)
    const valid = file('F001-1.xml')
    const screening = screenFileNames([long, valid])
    expect(screening.accepted).toEqual([valid])
    expect(screening.problems).toEqual([
      {
        code: 'INVALID_FILE_NAME',
        message: `El archivo «${'x'.repeat(64)}…» tiene un nombre que no podemos usar: debe tener hasta 255 caracteres y ningún carácter de control. Cámbiale el nombre y vuelve a adjuntarlo.`,
        params: { file: `${'x'.repeat(64)}…`, max: 255 },
      },
    ])
    // Sin `file`: ese campo siempre es un nombre tal como llegó, y este no se puede repetir.
    for (const problem of screening.problems) expect(problemSchema.parse(problem)).toEqual(problem)
    expect(JSON.stringify(screening.problems).length).toBeLessThan(512)
  })

  it('el borde: 255 unidades UTF-16 pasa y 256 es INVALID_FILE_NAME', () => {
    const atMax = file(`${'a'.repeat(251)}.xml`)
    const over = file(`${'a'.repeat(252)}.xml`)
    const screening = screenFileNames([atMax, over])
    expect(screening.accepted).toEqual([atMax])
    expect(screening.problems.map((p) => [p.code, p.params?.file])).toEqual([
      ['INVALID_FILE_NAME', `${'a'.repeat(64)}…`],
    ])
  })

  it.each([
    ['U+0000', 'F001-1\u0000.pdf', 'F001-1\uFFFD.pdf'],
    ['un salto de línea', 'F001-1\n.pdf', 'F001-1\uFFFD.pdf'],
    ['un control C1', 'F001-1\u0085.pdf', 'F001-1\uFFFD.pdf'],
    ['un sustituto suelto', 'F001-1\uD800.pdf', 'F001-1\uFFFD.pdf'],
  ])('un nombre con %s es INVALID_FILE_NAME y se muestra con U+FFFD', (_, name, shown) => {
    expect(screenFileNames([file(name)])).toEqual({
      accepted: [],
      problems: [
        expect.objectContaining({ code: 'INVALID_FILE_NAME', params: { file: shown, max: 255 } }),
      ],
    })
  })
})
