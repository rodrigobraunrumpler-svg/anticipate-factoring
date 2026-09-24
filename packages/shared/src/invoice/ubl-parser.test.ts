import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildCdrXml, buildInvoiceXml } from './build-test-xml.js'
import { decodeXml, parseUblInvoice } from './ubl-parser.js'

function parseOk(xml: string) {
  const r = parseUblInvoice(xml)
  if (!r.ok) throw new Error(`Se esperaba lectura correcta: ${r.problem.code}`)
  return r.invoice
}

function parseError(xml: string, options?: Parameters<typeof parseUblInvoice>[1]) {
  const r = parseUblInvoice(xml, options)
  if (r.ok) throw new Error('Se esperaba un problema')
  return r.problem
}

describe('parseUblInvoice · factura al crédito', () => {
  const inv = parseOk(buildInvoiceXml())

  it('lee identificación, fechas y moneda', () => {
    expect(inv.documentType).toBe('01')
    expect(inv.seriesNumber).toBe('F001-123')
    expect(inv.issueDate).toBe('2026-09-01')
    expect(inv.currency).toBe('PEN')
  })

  it('lee emisor y receptor', () => {
    expect(inv.issuerRuc).toBe('20100070970')
    expect(inv.issuerName).toBe('PROVEEDOR EJEMPLO S.A.C.')
    expect(inv.recipientRuc).toBe('20131312955')
    expect(inv.recipientName).toBe('SERVICIOS ENERGETICOS AMBIENTALES S.A.')
  })

  it('lee total, forma de pago, neto pendiente, cuotas y detracción', () => {
    expect(inv.total).toBe('11800.00')
    expect(inv.paymentTerms).toBe('CREDIT')
    expect(inv.netPendingAmount).toBe('10620.00')
    expect(inv.installments).toEqual([
      { id: 'Cuota001', amount: '10620.00', dueDate: '2026-11-30' },
    ])
    expect(inv.detraction).toEqual({ percent: 10, amount: '1180.00' })
    expect(inv.signed).toBe(true)
  })

  it('lee el fixture estático igual que el XML generado', () => {
    const fixture = readFileSync(
      new URL('../../test/fixtures/invoice-credit-pen.xml', import.meta.url),
      'utf8',
    )
    expect(parseOk(fixture)).toEqual(inv)
  })
})

describe('parseUblInvoice · referencias de carácter en texto', () => {
  it('decodifica &amp; en nombres', () => {
    const inv = parseOk(buildInvoiceXml({ issuerName: 'M &amp; M S.A.C.' }))
    expect(inv.issuerName).toBe('M & M S.A.C.')
  })

  it('decodifica referencias numéricas decimales', () => {
    const inv = parseOk(buildInvoiceXml({ issuerName: 'CASTA&#209;EDA S.A.C.' }))
    expect(inv.issuerName).toBe('CASTAÑEDA S.A.C.')
  })

  it('decodifica referencias numéricas hexadecimales', () => {
    const inv = parseOk(buildInvoiceXml({ issuerName: 'CASTA&#xD1;EDA' }))
    expect(inv.issuerName).toBe('CASTAÑEDA')
  })

  it('decodifica en una sola pasada: &amp;lt; no se convierte en <', () => {
    const inv = parseOk(buildInvoiceXml({ issuerName: 'A &amp;lt; B' }))
    expect(inv.issuerName).toBe('A &lt; B')
  })

  it('deja intacta una referencia con nombre desconocido', () => {
    const inv = parseOk(buildInvoiceXml({ issuerName: 'A &foo; B' }))
    expect(inv.issuerName).toBe('A &foo; B')
  })

  it('deja intacta una referencia decimal fuera del rango Unicode (&#1114112;)', () => {
    const inv = parseOk(buildInvoiceXml({ issuerName: 'X &#1114112; Y' }))
    expect(inv.issuerName).toBe('X &#1114112; Y')
  })

  it('deja intacta una referencia decimal desbordada', () => {
    const overlong = 'X &#99999999999999999999999999999999999999999999; Y'
    expect(parseOk(buildInvoiceXml({ issuerName: overlong })).issuerName).toBe(overlong)
  })

  it('deja intacta una referencia hexadecimal fuera del rango Unicode (&#x110000;)', () => {
    const inv = parseOk(buildInvoiceXml({ issuerName: 'X &#x110000; Y' }))
    expect(inv.issuerName).toBe('X &#x110000; Y')
  })

  it('nunca lanza: una referencia fuera de rango en el ID no revienta el parseo', () => {
    expect(() =>
      parseUblInvoice(buildInvoiceXml({ seriesNumber: 'F001-&#1114112;' })),
    ).not.toThrow()
  })
})

describe('parseUblInvoice · variantes', () => {
  it('factura al contado: sin neto pendiente ni cuotas', () => {
    const inv = parseOk(
      buildInvoiceXml({ paymentTerms: 'Contado', netPendingAmount: null, installments: [] }),
    )
    expect(inv.paymentTerms).toBe('CASH')
    expect(inv.netPendingAmount).toBeNull()
    expect(inv.installments).toEqual([])
  })

  it('sin bloque de forma de pago: paymentTerms null', () => {
    const inv = parseOk(buildInvoiceXml({ paymentTerms: null, installments: [] }))
    expect(inv.paymentTerms).toBeNull()
  })

  it('varias cuotas', () => {
    const installments = [
      { id: 'Cuota001', amount: '5000.00', dueDate: '2026-10-30' },
      { id: 'Cuota002', amount: '5620.00', dueDate: '2026-11-30' },
    ]
    expect(parseOk(buildInvoiceXml({ installments })).installments).toEqual(installments)
  })

  it('sin detracción ni razón social del receptor', () => {
    const inv = parseOk(buildInvoiceXml({ detraction: null, recipientName: null }))
    expect(inv.detraction).toBeNull()
    expect(inv.recipientName).toBeNull()
  })

  it('normaliza montos sin dos decimales', () => {
    const inv = parseOk(buildInvoiceXml({ total: '11800.5', netPendingAmount: '10620' }))
    expect(inv.total).toBe('11800.50')
    expect(inv.netPendingAmount).toBe('10620.00')
  })

  it('no firmada', () => {
    expect(parseOk(buildInvoiceXml({ signed: false })).signed).toBe(false)
  })

  it('lee una boleta (tipo 03) sin rechazarla; la regla de tipo decide después', () => {
    expect(parseOk(buildInvoiceXml({ documentType: '03' })).documentType).toBe('03')
  })
})

describe('parseUblInvoice · robustez de formato', () => {
  it('tolera BOM y finales de línea de Windows', () => {
    const inv = parseOk(buildInvoiceXml({ bom: true, windowsLineEndings: true }))
    expect(inv.seriesNumber).toBe('F001-123')
  })

  it('tolera elementos sin prefijo de espacio de nombres', () => {
    const inv = parseOk(buildInvoiceXml({ prefixes: { cbc: '', cac: '' } }))
    expect(inv.issuerRuc).toBe('20100070970')
  })

  it('tolera prefijos distintos de cbc/cac', () => {
    const inv = parseOk(buildInvoiceXml({ prefixes: { cbc: 'n1', cac: 'n2' } }))
    expect(inv.netPendingAmount).toBe('10620.00')
  })

  it('tolera la ruta legada del RUC (PartyTaxScheme/CompanyID)', () => {
    const inv = parseOk(buildInvoiceXml({ legacyRucPath: true }))
    expect(inv.issuerRuc).toBe('20100070970')
    expect(inv.recipientRuc).toBe('20131312955')
    expect(inv.issuerName).toBe('PROVEEDOR EJEMPLO S.A.C.')
  })
})

describe('parseUblInvoice · errores', () => {
  it('XML malformado', () => {
    expect(parseError('<Invoice><cbc:ID>F001-1</Invoice>').code).toBe('UNREADABLE_XML')
  })

  it('texto que no es XML', () => {
    expect(parseError('%PDF-1.7 ...').code).toBe('UNREADABLE_XML')
  })

  it('CDR de SUNAT', () => {
    const p = parseError(buildCdrXml())
    expect(p.code).toBe('XML_NOT_AN_INVOICE')
    expect(p.message).toContain('constancia de recepción')
  })

  it('nota de crédito', () => {
    const p = parseError(buildInvoiceXml({ root: 'CreditNote' }))
    expect(p.code).toBe('XML_NOT_AN_INVOICE')
    expect(p.message).toContain('nota de crédito')
  })

  it('una raíz que coincide con una propiedad heredada del objeto no expone su valor', () => {
    const p = parseError('<?xml version="1.0" encoding="UTF-8"?><isPrototypeOf/>')
    expect(p.code).toBe('XML_NOT_AN_INVOICE')
    expect(p.message).toContain('isPrototypeOf')
    expect(p.message).not.toContain('native code')
  })

  it.each([
    ['ID', 'serie y número'],
    ['IssueDate', 'fecha de emisión'],
    ['InvoiceTypeCode', 'tipo de comprobante'],
    ['DocumentCurrencyCode', 'moneda'],
    ['PayableAmount', 'total'],
  ] as const)('falta %s', (element, name) => {
    const p = parseError(buildInvoiceXml({ omit: [element] }))
    expect(p.code).toBe('XML_MISSING_REQUIRED_FIELD')
    expect(p.message).toContain(name)
  })

  it('rechaza cualquier DOCTYPE, que es la puerta de las entidades externas', () => {
    const xml = buildInvoiceXml()
      .replace(
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>',
      )
      .replace('F001-123', '&xxe;')
    expect(parseError(xml).code).toBe('XML_DOCTYPE_NOT_ALLOWED')
  })

  it('rechaza un XML mayor al tope recibido por parámetro', () => {
    const xml = buildInvoiceXml()
    expect(parseError(xml, { maxLength: 100 }).code).toBe('XML_TOO_LARGE')
    expect(parseUblInvoice(xml, { maxLength: xml.length }).ok).toBe(true)
  })
})

describe('decodeXml', () => {
  it('decodifica UTF-8 con BOM', () => {
    const bytes = new TextEncoder().encode('﻿<?xml version="1.0" encoding="UTF-8"?><a>Ñ</a>')
    expect(decodeXml(bytes)).toContain('<a>Ñ</a>')
  })

  it('respeta la codificación declarada (ISO-8859-1)', () => {
    const text = '<?xml version="1.0" encoding="ISO-8859-1"?><a>Ñ</a>'
    const bytes = Uint8Array.from(text, (ch) => ch.charCodeAt(0))
    expect(decodeXml(bytes)).toContain('<a>Ñ</a>')
  })
})
