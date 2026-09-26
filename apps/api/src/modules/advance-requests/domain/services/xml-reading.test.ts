import { createProblem } from '@anticipate/shared/errors'
import { decodeXml, parseUblInvoice } from '@anticipate/shared/invoice'
import { buildInvoiceXml } from '@anticipate/shared/testing'
import { describe, expect, it } from 'vitest'
import type { UploadedFile } from '../types/invoice-intake.types.js'
import { oversizedXmlProblem, toXmlFileReading, unreadableXmlProblem } from './xml-reading.js'

const MAX_XML_BYTES = 1024 * 1024
const xmlFile = (originalname: string, content: string): UploadedFile => {
  const buffer = Buffer.from(content, 'utf8')
  return { originalname, buffer, size: buffer.length }
}
/** La lectura que corre el worker del lector (`invoice-xml-parser.worker.ts`), aquí en el mismo hilo. */
const read = (file: UploadedFile) =>
  toXmlFileReading(file, parseUblInvoice(decodeXml(file.buffer), { maxLength: MAX_XML_BYTES }))

describe('oversizedXmlProblem', () => {
  it('un XML justo en el tope pasa; con un byte más que el tope es XML_TOO_LARGE', () => {
    const file = xmlFile('F001-123.xml', buildInvoiceXml())
    expect(oversizedXmlProblem(file, file.size)).toBeNull()
    expect(oversizedXmlProblem(file, file.size - 1)).toEqual(
      expect.objectContaining({ code: 'XML_TOO_LARGE', file: 'F001-123.xml' }),
    )
  })

  it('un XML mayor al tope es XML_TOO_LARGE con su nombre, aunque sea válido', () => {
    const content = buildInvoiceXml()
    expect(oversizedXmlProblem(xmlFile('F001-123.xml', content), content.length - 1)).toEqual(
      createProblem('XML_TOO_LARGE', { file: 'F001-123.xml' }),
    )
  })

  it('un XML mayor al tope se rechaza sin leer su contenido', () => {
    const tooLarge: UploadedFile = {
      originalname: 'enorme.xml',
      size: MAX_XML_BYTES + 1,
      get buffer(): Buffer {
        throw new Error('no debía leer el contenido')
      },
    }
    expect(oversizedXmlProblem(tooLarge, MAX_XML_BYTES)).toEqual(
      expect.objectContaining({ code: 'XML_TOO_LARGE', file: 'enorme.xml' }),
    )
  })
})

describe('toXmlFileReading', () => {
  it('una factura leída conserva su archivo', () => {
    const file = xmlFile('F001-2.xml', buildInvoiceXml({ seriesNumber: 'F001-2' }))
    const reading = read(file)
    if (!reading.ok) throw new Error(reading.problem.code)
    expect(reading.read.invoice.seriesNumber).toBe('F001-2')
    expect(reading.read.file).toBe(file)
  })

  it('un archivo que no es XML es UNREADABLE_XML con su nombre', () => {
    expect(read(xmlFile('F001-2.xml', '%PDF-1.7 no soy xml'))).toEqual({
      ok: false,
      problem: expect.objectContaining({ code: 'UNREADABLE_XML', file: 'F001-2.xml' }),
    })
  })

  it.each([
    ['U+0000', 'PROV\u0000EEDOR'],
    ['un control C0', 'PROV\u0001EEDOR'],
  ])(
    'un XML con %s en un dato es UNREADABLE_XML con su nombre, nunca una factura leída',
    (_, issuerName) => {
      expect(read(xmlFile('F001-123.xml', buildInvoiceXml({ issuerName })))).toEqual({
        ok: false,
        problem: expect.objectContaining({ code: 'UNREADABLE_XML', file: 'F001-123.xml' }),
      })
    },
  )

  it('el problema del lector conserva el dato de la factura y suma el archivo', () => {
    expect(read(xmlFile('sin-fecha.xml', buildInvoiceXml({ omit: ['IssueDate'] })))).toEqual({
      ok: false,
      problem: expect.objectContaining({
        code: 'XML_MISSING_REQUIRED_FIELD',
        field: 'issueDate',
        file: 'sin-fecha.xml',
      }),
    })
  })

  it('una fecha de emisión en el año 0000, que PostgreSQL no guarda, es XML_INVALID_FIELD con su nombre', () => {
    expect(read(xmlFile('F001-123.xml', buildInvoiceXml({ issueDate: '0000-01-01' })))).toEqual({
      ok: false,
      problem: expect.objectContaining({
        code: 'XML_INVALID_FIELD',
        field: 'issueDate',
        file: 'F001-123.xml',
      }),
    })
  })
})

describe('unreadableXmlProblem', () => {
  it('un XML que el lector no pudo terminar es UNREADABLE_XML con su nombre', () => {
    expect(unreadableXmlProblem(xmlFile('hostil.xml', '<Invoice/>'))).toEqual(
      createProblem('UNREADABLE_XML', { file: 'hostil.xml' }),
    )
  })
})
