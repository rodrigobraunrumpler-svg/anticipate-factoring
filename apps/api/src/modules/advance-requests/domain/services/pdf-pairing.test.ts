import { describe, expect, it } from 'vitest'
import type { UploadedFile } from '../types/invoice-intake.types.js'
import { baseName, isPdf, pairPdfs } from './pdf-pairing.js'

const MB = 1024 * 1024
const file = (originalname: string, content: string | Buffer = '%PDF-1.7\n'): UploadedFile => {
  const buffer = typeof content === 'string' ? Buffer.from(content, 'latin1') : content
  return { originalname, buffer, size: buffer.length }
}

describe('isPdf', () => {
  it('reconoce un PDF por su firma, no por su nombre', () => {
    expect(isPdf(Buffer.from('%PDF-1.7\n1 0 obj'))).toBe(true)
    expect(isPdf(Buffer.from('<?xml version="1.0"?>'))).toBe(false)
    expect(isPdf(Buffer.alloc(0))).toBe(false)
  })

  it('acepta la firma dentro del primer kilobyte y no más allá', () => {
    expect(isPdf(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('%PDF-1.4')]))).toBe(
      true,
    )
    expect(isPdf(Buffer.concat([Buffer.alloc(1019, 0x20), Buffer.from('%PDF-1.4')]))).toBe(true)
    expect(isPdf(Buffer.concat([Buffer.alloc(1020, 0x20), Buffer.from('%PDF-1.4')]))).toBe(false)
  })
})

describe('baseName', () => {
  it('ignora extensión, mayúsculas, espacios y ruta', () => {
    expect(baseName('F001-123.XML')).toBe('f001-123')
    expect(baseName('C:\\docs\\F001-123.pdf')).toBe('f001-123')
    expect(baseName('carpeta/f001-123.Pdf')).toBe('f001-123')
    expect(baseName(' F001-123 .pdf')).toBe('f001-123')
  })

  it('iguala nombres con tildes escritas en NFC y en NFD', () => {
    expect(baseName('Facturación-1.xml'.normalize('NFD'))).toBe(
      baseName('Facturación-1.pdf'.normalize('NFC')),
    )
  })

  it('un nombre sin extensión o que empieza con punto se queda entero', () => {
    expect(baseName('F001-123')).toBe('f001-123')
    expect(baseName('.pdf')).toBe('.pdf')
  })
})

describe('pairPdfs', () => {
  it('empareja cada PDF con el XML del mismo nombre base, por identidad del XML', () => {
    const xmls = [file('F001-1.xml'), file('F001-2.xml')]
    const pdfs = [file('f001-2.PDF'), file('F001-9.pdf'), file('F001-2 (copia).pdf')]
    const { pdfByXml, problems } = pairPdfs(xmls, pdfs, MB)
    expect(pdfByXml.get(xmls[1] as UploadedFile)).toBe(pdfs[0])
    expect(pdfByXml.has(xmls[0] as UploadedFile)).toBe(false)
    expect(problems.map((p) => [p.code, p.file])).toEqual([
      ['PDF_WITHOUT_XML', 'F001-9.pdf'],
      ['PDF_WITHOUT_XML', 'F001-2 (copia).pdf'],
    ])
  })

  it('un segundo PDF para el mismo XML es un problema', () => {
    const { problems } = pairPdfs(
      [file('F001-1.xml')],
      [file('F001-1.pdf'), file('f001-1.PDF')],
      MB,
    )
    expect(problems.map((p) => [p.code, p.file])).toEqual([['PDF_WITHOUT_XML', 'f001-1.PDF']])
  })

  it('un PDF que no lo es por contenido es un problema con su nombre', () => {
    const { pdfByXml, problems } = pairPdfs(
      [file('F001-1.xml')],
      [file('F001-1.pdf', 'no soy un pdf')],
      MB,
    )
    expect(pdfByXml.size).toBe(0)
    expect(problems).toEqual([
      expect.objectContaining({
        code: 'INVALID_PDF',
        file: 'F001-1.pdf',
        params: { file: 'F001-1.pdf' },
      }),
    ])
  })

  it('un PDF mayor al tope es un problema con su nombre y el tope en MB', () => {
    const big = file('F001-1.pdf', `%PDF-1.7${' '.repeat(2 * MB)}`)
    const { problems } = pairPdfs([file('F001-1.xml')], [big], MB)
    expect(problems).toEqual([
      expect.objectContaining({
        code: 'FILE_TOO_LARGE',
        file: 'F001-1.pdf',
        params: { file: 'F001-1.pdf', max: 1 },
      }),
    ])
    expect(problems[0]?.message).toBe('El archivo F001-1.pdf supera el máximo de 1 MB.')
  })

  it('el tope en MB se trunca a dos decimales', () => {
    const big = file('F001-1.pdf', `%PDF-1.7${' '.repeat(2 * MB)}`)
    const { problems } = pairPdfs([file('F001-1.xml')], [big], 1.5 * MB + 1)
    expect(problems[0]?.params).toEqual({ file: 'F001-1.pdf', max: 1.5 })
  })

  it('sin PDF no hay emparejamiento ni problemas', () => {
    expect(pairPdfs([file('F001-1.xml')], [], MB)).toEqual({ pdfByXml: new Map(), problems: [] })
  })
})
