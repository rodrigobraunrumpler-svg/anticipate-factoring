import { buildInvoiceXml } from '@anticipate/shared/testing'
import { describe, expect, it } from 'vitest'
import type { UploadedFile } from '../types/invoice-intake.types.js'
import { readInvoices } from './xml-reading.js'

const MAX_XML_BYTES = 1024 * 1024
const xmlFile = (originalname: string, content: string): UploadedFile => {
  const buffer = Buffer.from(content, 'utf8')
  return { originalname, buffer, size: buffer.length }
}

describe('readInvoices', () => {
  it('lee cada XML en el orden recibido y conserva el archivo de cada factura', () => {
    const files = [
      xmlFile('F001-2.xml', buildInvoiceXml({ seriesNumber: 'F001-2' })),
      xmlFile('F001-1.xml', buildInvoiceXml({ seriesNumber: 'F001-1' })),
    ]
    const { read, problems } = readInvoices(files, MAX_XML_BYTES)
    expect(problems).toEqual([])
    expect(read.map((r) => r.invoice.seriesNumber)).toEqual(['F001-2', 'F001-1'])
    expect(read[0]?.file).toBe(files[0])
    expect(read[1]?.file).toBe(files[1])
  })

  it('un XML mayor al tope es XML_TOO_LARGE con su nombre, aunque sea válido', () => {
    const content = buildInvoiceXml()
    const { read, problems } = readInvoices([xmlFile('F001-123.xml', content)], content.length - 1)
    expect(read).toEqual([])
    expect(problems).toEqual([
      expect.objectContaining({ code: 'XML_TOO_LARGE', file: 'F001-123.xml' }),
    ])
  })

  it('un archivo que no es XML es UNREADABLE_XML con su nombre y no impide leer los demás', () => {
    const { read, problems } = readInvoices(
      [
        xmlFile('F001-2.xml', '%PDF-1.7 no soy xml'),
        xmlFile('F001-1.xml', buildInvoiceXml({ seriesNumber: 'F001-1' })),
      ],
      MAX_XML_BYTES,
    )
    expect(read.map((r) => r.invoice.seriesNumber)).toEqual(['F001-1'])
    expect(problems).toEqual([
      expect.objectContaining({ code: 'UNREADABLE_XML', file: 'F001-2.xml' }),
    ])
  })

  it.each([
    ['U+0000', 'PROV\u0000EEDOR'],
    ['un control C0', 'PROV\u0001EEDOR'],
  ])(
    'un XML con %s en un dato es UNREADABLE_XML con su nombre, nunca una factura leída',
    (_, issuerName) => {
      const { read, problems } = readInvoices(
        [xmlFile('F001-123.xml', buildInvoiceXml({ issuerName }))],
        MAX_XML_BYTES,
      )
      expect(read).toEqual([])
      expect(problems).toEqual([
        expect.objectContaining({ code: 'UNREADABLE_XML', file: 'F001-123.xml' }),
      ])
    },
  )

  it('el problema del lector conserva el dato de la factura y suma el archivo', () => {
    const { problems } = readInvoices(
      [xmlFile('sin-fecha.xml', buildInvoiceXml({ omit: ['IssueDate'] }))],
      MAX_XML_BYTES,
    )
    expect(problems).toEqual([
      expect.objectContaining({
        code: 'XML_MISSING_REQUIRED_FIELD',
        field: 'issueDate',
        file: 'sin-fecha.xml',
      }),
    ])
  })
})
