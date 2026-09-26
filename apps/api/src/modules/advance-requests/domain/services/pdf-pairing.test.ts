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

  it('acepta la cabecera entera dentro del primer kilobyte y no más allá', () => {
    const header = Buffer.from('%PDF-1.4')
    const bom = Buffer.from([0xef, 0xbb, 0xbf])
    expect(isPdf(Buffer.concat([bom, header]))).toBe(true)
    expect(isPdf(Buffer.concat([Buffer.alloc(1016, 0x20), header]))).toBe(true)
    expect(isPdf(Buffer.concat([Buffer.alloc(1017, 0x20), header]))).toBe(false)
    expect(isPdf(Buffer.concat([bom, Buffer.alloc(1013, 0x20), header]))).toBe(true)
    expect(isPdf(Buffer.concat([bom, Buffer.alloc(1014, 0x20), header]))).toBe(false)
  })

  it('antes de la cabecera solo admite la marca UTF-8 y espacio en blanco de PDF', () => {
    expect(isPdf(Buffer.from('\r\n\t\f \0%PDF-2.0\n'))).toBe(true)
    expect(
      isPdf(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('\n %PDF-1.7')])),
    ).toBe(true)
    // Una página HTML que menciona la firma no es un PDF, ni nada con otros bytes delante.
    expect(isPdf(Buffer.from('<html><script>var s = "%PDF-1.7"</script></html>'))).toBe(false)
    expect(isPdf(Buffer.from('x%PDF-1.7\n'))).toBe(false)
    expect(isPdf(Buffer.from('HTTP/1.1 200 OK\r\n\r\n%PDF-1.7\n'))).toBe(false)
    // La marca UTF-8 solo al principio.
    expect(
      isPdf(
        Buffer.concat([Buffer.from(' '), Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('%PDF-1.7')]),
      ),
    ).toBe(false)
  })

  it('exige la versión después de la firma: %PDF- solo no es un PDF', () => {
    expect(isPdf(Buffer.from('%PDF-'))).toBe(false)
    expect(isPdf(Buffer.from('%PDF-1'))).toBe(false)
    expect(isPdf(Buffer.from('%PDF-1.'))).toBe(false)
    expect(isPdf(Buffer.from('%PDF-x.y'))).toBe(false)
    expect(isPdf(Buffer.from('%PDF-1.7'))).toBe(true)
    expect(isPdf(Buffer.from('%PDF-2.0'))).toBe(true)
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

  it('dos XML con el mismo nombre (carpetas distintas) son un problema y el PDF no va a ninguno', () => {
    // El navegador descarta la carpeta: a/factura.xml y b/factura.xml llegan como factura.xml.
    const xmls = [file('factura.xml', 'F001-2'), file('factura.xml', 'F001-1')]
    const { pdfByXml, problems } = pairPdfs(xmls, [file('factura.pdf')], MB)
    expect(pdfByXml.size).toBe(0)
    expect(problems).toEqual([
      {
        code: 'DUPLICATE_FILE_NAME',
        message: expect.stringContaining('Cambia el nombre'),
        file: 'factura.xml',
        params: { file: 'factura.xml' },
      },
    ])
  })

  it('con un PDF por XML y nombres repetidos, ningún PDF se empareja ni es PDF_WITHOUT_XML', () => {
    const xmls = [file('factura.xml', 'F001-1'), file('factura.xml', 'F001-2')]
    const { pdfByXml, problems } = pairPdfs(xmls, [file('factura.pdf'), file('factura.pdf')], MB)
    expect(pdfByXml.size).toBe(0)
    expect(problems.map((p) => [p.code, p.file])).toEqual([['DUPLICATE_FILE_NAME', 'factura.xml']])
  })

  it.each([
    ['mayúsculas', 'F001-1.xml', 'f001-1.xml', 'F001-1.pdf'],
    ['mayúsculas de la extensión', 'F001-1.xml', 'F001-1.XML', 'F001-1.pdf'],
    ['otra extensión', 'F001-1.xml', 'F001-1.txt', 'F001-1.pdf'],
    ['espacios alrededor', 'F001-1.xml', ' F001-1 .xml', 'F001-1.pdf'],
    [
      'NFC y NFD',
      'Facturación-1.xml'.normalize('NFC'),
      'Facturación-1.xml'.normalize('NFD'),
      'Facturación-1.pdf',
    ],
  ])(
    'dos XML cuyo nombre base coincide (%s) son un problema cada uno, y su PDF no va a ninguno',
    (_, first, second, pdfName) => {
      const xmls = [file(first), file('F001-2.xml'), file(second)]
      const pdfs = [file(pdfName), file('F001-2.pdf')]
      const { pdfByXml, problems } = pairPdfs(xmls, pdfs, MB)
      expect(problems.map((p) => [p.code, p.file])).toEqual([
        ['DUPLICATE_FILE_NAME', first],
        ['DUPLICATE_FILE_NAME', second],
      ])
      // El XML sin ambigüedad sigue con su PDF.
      expect(pdfByXml.size).toBe(1)
      expect(pdfByXml.get(xmls[1] as UploadedFile)).toBe(pdfs[1])
    },
  )

  it('los nombres repetidos se informan en el orden de los XML, un problema por nombre distinto', () => {
    const xmls = [
      file('B.xml'),
      file('a.xml'),
      file('b.XML'),
      file('A.xml'),
      file('a.xml'),
      file('c.xml'),
    ]
    expect(pairPdfs(xmls, [], MB).problems.map((p) => [p.code, p.file])).toEqual([
      ['DUPLICATE_FILE_NAME', 'B.xml'],
      ['DUPLICATE_FILE_NAME', 'a.xml'],
      ['DUPLICATE_FILE_NAME', 'b.XML'],
      ['DUPLICATE_FILE_NAME', 'A.xml'],
    ])
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

  it('un PDF roto y sin XML informa los dos problemas; uno mayor al tope y sin XML, también', () => {
    const { problems } = pairPdfs(
      [file('F001-1.xml')],
      [
        file('F001-8.pdf', 'no soy un pdf'),
        file('F001-9.pdf', `%PDF-1.7${' '.repeat(2 * MB)}`),
        file('F001-7.pdf', `no soy un pdf${' '.repeat(2 * MB)}`),
      ],
      MB,
    )
    expect(problems.map((p) => [p.code, p.file])).toEqual([
      ['INVALID_PDF', 'F001-8.pdf'],
      ['PDF_WITHOUT_XML', 'F001-8.pdf'],
      ['FILE_TOO_LARGE', 'F001-9.pdf'],
      ['PDF_WITHOUT_XML', 'F001-9.pdf'],
      ['FILE_TOO_LARGE', 'F001-7.pdf'],
      ['INVALID_PDF', 'F001-7.pdf'],
      ['PDF_WITHOUT_XML', 'F001-7.pdf'],
    ])
  })

  it('un PDF con problemas ocupa el lugar de su XML sin emparejarse: el segundo PDF también se informa', () => {
    const xml = file('F001-1.xml')
    const { pdfByXml, problems } = pairPdfs(
      [xml],
      [file('F001-1.pdf', 'no soy un pdf'), file('f001-1.PDF')],
      MB,
    )
    expect(pdfByXml.size).toBe(0)
    expect(problems.map((p) => [p.code, p.file])).toEqual([
      ['INVALID_PDF', 'F001-1.pdf'],
      ['PDF_WITHOUT_XML', 'f001-1.PDF'],
    ])
  })

  it('un PDF justo en el tope se acepta; un byte más es FILE_TOO_LARGE', () => {
    const xml = file('F001-1.xml')
    const atCap = file('F001-1.pdf', '%PDF-1.7\n%%EOF\n')
    expect(pairPdfs([xml], [atCap], atCap.size)).toEqual({
      pdfByXml: new Map([[xml, atCap]]),
      problems: [],
    })
    expect(pairPdfs([xml], [atCap], atCap.size - 1).problems.map((p) => p.code)).toEqual([
      'FILE_TOO_LARGE',
    ])
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
