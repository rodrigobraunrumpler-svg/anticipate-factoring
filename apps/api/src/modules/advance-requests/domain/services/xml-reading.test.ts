import { buildInvoiceXml } from '@anticipate/shared/testing'
import { describe, expect, it } from 'vitest'
import type { UploadedFile } from '../types/invoice-intake.types.js'
import { readInvoice } from './xml-reading.js'

const MAX_XML_BYTES = 1024 * 1024
const xmlFile = (originalname: string, content: string): UploadedFile => {
  const buffer = Buffer.from(content, 'utf8')
  return { originalname, buffer, size: buffer.length }
}

describe('readInvoice', () => {
  it('lee un XML y conserva su archivo', () => {
    const file = xmlFile('F001-2.xml', buildInvoiceXml({ seriesNumber: 'F001-2' }))
    const reading = readInvoice(file, MAX_XML_BYTES)
    if (!reading.ok) throw new Error(reading.problem.code)
    expect(reading.read.invoice.seriesNumber).toBe('F001-2')
    expect(reading.read.file).toBe(file)
  })

  it('un XML justo en el tope se lee; con un byte más que el tope es XML_TOO_LARGE', () => {
    const file = xmlFile('F001-123.xml', buildInvoiceXml())
    const atCap = readInvoice(file, file.size)
    if (!atCap.ok) throw new Error(atCap.problem.code)
    expect(atCap.read.invoice.seriesNumber).toBe('F001-123')
    expect(readInvoice(file, file.size - 1)).toEqual({
      ok: false,
      problem: expect.objectContaining({ code: 'XML_TOO_LARGE', file: 'F001-123.xml' }),
    })
  })

  it('un XML mayor al tope es XML_TOO_LARGE con su nombre, aunque sea válido', () => {
    const content = buildInvoiceXml()
    expect(readInvoice(xmlFile('F001-123.xml', content), content.length - 1)).toEqual({
      ok: false,
      problem: expect.objectContaining({ code: 'XML_TOO_LARGE', file: 'F001-123.xml' }),
    })
  })

  it('un XML mayor al tope se rechaza sin leer su contenido', () => {
    const tooLarge: UploadedFile = {
      originalname: 'enorme.xml',
      size: MAX_XML_BYTES + 1,
      get buffer(): Buffer {
        throw new Error('no debía leer el contenido')
      },
    }
    expect(readInvoice(tooLarge, MAX_XML_BYTES)).toEqual({
      ok: false,
      problem: expect.objectContaining({ code: 'XML_TOO_LARGE', file: 'enorme.xml' }),
    })
  })

  it('un archivo que no es XML es UNREADABLE_XML con su nombre', () => {
    expect(readInvoice(xmlFile('F001-2.xml', '%PDF-1.7 no soy xml'), MAX_XML_BYTES)).toEqual({
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
      expect(
        readInvoice(xmlFile('F001-123.xml', buildInvoiceXml({ issuerName })), MAX_XML_BYTES),
      ).toEqual({
        ok: false,
        problem: expect.objectContaining({ code: 'UNREADABLE_XML', file: 'F001-123.xml' }),
      })
    },
  )

  it('el problema del lector conserva el dato de la factura y suma el archivo', () => {
    expect(
      readInvoice(
        xmlFile('sin-fecha.xml', buildInvoiceXml({ omit: ['IssueDate'] })),
        MAX_XML_BYTES,
      ),
    ).toEqual({
      ok: false,
      problem: expect.objectContaining({
        code: 'XML_MISSING_REQUIRED_FIELD',
        field: 'issueDate',
        file: 'sin-fecha.xml',
      }),
    })
  })

  it('una fecha de emisión en el año 0000, que PostgreSQL no guarda, es XML_INVALID_FIELD con su nombre', () => {
    expect(
      readInvoice(
        xmlFile('F001-123.xml', buildInvoiceXml({ issueDate: '0000-01-01' })),
        MAX_XML_BYTES,
      ),
    ).toEqual({
      ok: false,
      problem: expect.objectContaining({
        code: 'XML_INVALID_FIELD',
        field: 'issueDate',
        file: 'F001-123.xml',
      }),
    })
  })
})
