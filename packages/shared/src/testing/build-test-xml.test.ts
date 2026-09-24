import { describe, expect, it } from 'vitest'
import { parseUblInvoice } from '../invoice/index.js'
import { buildInvoiceXml, escapeXmlText } from './build-test-xml.js'

function parseOk(xml: string) {
  const r = parseUblInvoice(xml)
  if (!r.ok) throw new Error(`Se esperaba lectura correcta: ${r.problem.code}`)
  return r.invoice
}

describe('buildInvoiceXml · escape del texto', () => {
  it("issuerName 'A & B' produce XML válido que se lee como 'A & B'", () => {
    const xml = buildInvoiceXml({ issuerName: 'A & B' })
    expect(xml).toContain('A &amp; B')
    expect(parseOk(xml).issuerName).toBe('A & B')
  })

  it('escapa <, > y comillas en el texto', () => {
    const name = 'A <B> "C" & D'
    expect(parseOk(buildInvoiceXml({ issuerName: name, recipientName: name })).recipientName).toBe(
      name,
    )
  })

  it('escapa los atributos: el XML sigue bien formado y el dato inválido se informa como tal', () => {
    const r = parseUblInvoice(buildInvoiceXml({ currency: 'P"N' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.problem.code).toBe('XML_INVALID_FIELD')
  })

  it('en CDATA no escapa y parte un "]]>" en dos secciones', () => {
    const name = 'X ]]> & <Y>'
    const xml = buildInvoiceXml({ cdataNames: true, issuerName: name })
    expect(xml).toContain('<![CDATA[X ]]]]><![CDATA[> & <Y>]]>')
    expect(parseOk(xml).issuerName).toBe(name)
  })

  it('escapeXmlText escapa los cuatro caracteres y nada más', () => {
    expect(escapeXmlText(`&<>"'`)).toBe(`&amp;&lt;&gt;&quot;'`)
  })
})
