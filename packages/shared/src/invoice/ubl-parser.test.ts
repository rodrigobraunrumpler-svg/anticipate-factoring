import { readFileSync } from 'node:fs'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { buildCdrXml, buildInvoiceXml, DEFAULT_TEST_XML } from '../testing/index.js'
import { parsedInvoiceSchema } from './parsed-invoice.js'
import { decodeXml, type ParseResult, parseUblInvoice } from './ubl-parser.js'
import { isXmlText } from './xml-text.js'

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

/**
 * La fábrica escapa todo texto; para probar referencias de carácter hay que inyectarlas tal cual en
 * el XML ya construido.
 */
const withRawIssuerName = (raw: string) =>
  buildInvoiceXml().replace(`>${DEFAULT_TEST_XML.issuerName}<`, `>${raw}<`)

describe('parseUblInvoice · referencias de carácter en texto', () => {
  it('decodifica &amp; en nombres', () => {
    const inv = parseOk(withRawIssuerName('M &amp; M S.A.C.'))
    expect(inv.issuerName).toBe('M & M S.A.C.')
  })

  it('decodifica referencias numéricas decimales', () => {
    const inv = parseOk(withRawIssuerName('CASTA&#209;EDA S.A.C.'))
    expect(inv.issuerName).toBe('CASTAÑEDA S.A.C.')
  })

  it('decodifica referencias numéricas hexadecimales', () => {
    const inv = parseOk(withRawIssuerName('CASTA&#xD1;EDA'))
    expect(inv.issuerName).toBe('CASTAÑEDA')
  })

  it('decodifica en una sola pasada: &amp;lt; no se convierte en <', () => {
    const inv = parseOk(withRawIssuerName('A &amp;lt; B'))
    expect(inv.issuerName).toBe('A &lt; B')
  })

  it('deja intacta una referencia con nombre desconocido', () => {
    const inv = parseOk(withRawIssuerName('A &foo; B'))
    expect(inv.issuerName).toBe('A &foo; B')
  })

  it('deja intacta una referencia decimal fuera del rango Unicode (&#1114112;)', () => {
    const inv = parseOk(withRawIssuerName('X &#1114112; Y'))
    expect(inv.issuerName).toBe('X &#1114112; Y')
  })

  it('deja intacta una referencia decimal desbordada', () => {
    const overlong = 'X &#99999999999999999999999999999999999999999999; Y'
    expect(parseOk(withRawIssuerName(overlong)).issuerName).toBe(overlong)
  })

  it('deja intacta una referencia hexadecimal fuera del rango Unicode (&#x110000;)', () => {
    const inv = parseOk(withRawIssuerName('X &#x110000; Y'))
    expect(inv.issuerName).toBe('X &#x110000; Y')
  })

  it('nunca lanza: una referencia fuera de rango en el ID no revienta el parseo', () => {
    expect(() =>
      parseUblInvoice(buildInvoiceXml().replace('>F001-123<', '>F001-&#1114112;<')),
    ).not.toThrow()
  })

  it.each([
    ['U+0000', '&#0;'],
    ['U+0000 en hexadecimal', '&#x0;'],
    ['un control C0', '&#1;'],
    ['U+001F', '&#x1F;'],
    ['un sustituto alto', '&#xD800;'],
    ['un sustituto bajo', '&#56320;'],
    ['U+FFFE', '&#xFFFE;'],
    ['U+FFFF', '&#65535;'],
  ])('deja intacta una referencia a un carácter que XML no admite (%s)', (_, reference) => {
    const inv = parseOk(withRawIssuerName(`X ${reference} Y`))
    expect(inv.issuerName).toBe(`X ${reference} Y`)
  })

  it('decodifica las referencias a tabulación, salto de línea y retorno de carro', () => {
    const inv = parseOk(withRawIssuerName('A&#9;B&#xA;C&#13;D'))
    expect(inv.issuerName).toBe('A\tB\nC\rD')
  })
})

describe('parseUblInvoice · caracteres que XML no admite', () => {
  /*
   * XML 1.0 (§2.2) solo admite tabulación, salto de línea, retorno de carro y Unicode sin los demás
   * controles C0, sin sustitutos sueltos y sin U+FFFE/U+FFFF. Un documento con otro carácter no está
   * bien formado. Además, PostgreSQL no guarda U+0000 en `text`: un nombre que lo trae haría fallar
   * el INSERT de la factura en vez de volver al proveedor como un problema de su archivo.
   */
  it.each([
    ['U+0000', '\u0000'],
    ['un control C0', '\u0001'],
    ['U+000B', '\u000B'],
    ['U+001F', '\u001F'],
    ['U+FFFE', '\uFFFE'],
    ['U+FFFF', '\uFFFF'],
    ['un sustituto suelto', '\uD800'],
  ])('un XML con %s escrito tal cual en un dato es UNREADABLE_XML', (_, character) => {
    expect(parseError(buildInvoiceXml({ issuerName: `PROV${character}EEDOR` })).code).toBe(
      'UNREADABLE_XML',
    )
  })

  it('también fuera de los datos que se leen: en un comentario o en una sección CDATA', () => {
    const xml = buildInvoiceXml()
    expect(parseError(xml.replace('<cbc:ID>', '<!-- \u0000 --><cbc:ID>')).code).toBe(
      'UNREADABLE_XML',
    )
    expect(parseError(buildInvoiceXml({ issuerName: 'A\u0000B', cdataNames: true })).code).toBe(
      'UNREADABLE_XML',
    )
  })

  it('acepta tabulación, saltos de línea, tildes y caracteres fuera del plano básico', () => {
    const inv = parseOk(withRawIssuerName('CASTAÑEDA\tE HIJOS 😀 \uE000 \uFFFD'))
    expect(inv.issuerName).toBe('CASTAÑEDA\tE HIJOS 😀 \uE000 \uFFFD')
  })

  it('lo decodificado desde bytes UTF-8 con un 0x00 también es UNREADABLE_XML', () => {
    const bytes = new TextEncoder().encode(buildInvoiceXml({ issuerName: 'PROV\u0000EEDOR' }))
    expect(bytes.includes(0)).toBe(true)
    expect(parseError(decodeXml(bytes)).code).toBe('UNREADABLE_XML')
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
    const xml = buildInvoiceXml({ bom: true, windowsLineEndings: true })
    expect(xml.startsWith('\uFEFF')).toBe(true)
    const inv = parseOk(xml)
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

  it('rechaza un DOCTYPE en minúsculas y precedido de espacios', () => {
    const body = buildInvoiceXml().replace('<?xml version="1.0" encoding="UTF-8"?>\n', '')
    expect(parseError(`  \n\t<!doctype Invoice>\n${body}`).code).toBe('XML_DOCTYPE_NOT_ALLOWED')
    expect(
      parseError(buildInvoiceXml().replace('?>', '?>\n   <!doctype x [<!ENTITY a "b">]>')).code,
    ).toBe('XML_DOCTYPE_NOT_ALLOWED')
    expect(parseError(buildInvoiceXml().replace('?>', '?><! DOCTYPE x>')).code).toBe(
      'XML_DOCTYPE_NOT_ALLOWED',
    )
  })

  it('ignora una instrucción de procesamiento antes de la raíz', () => {
    const xml = buildInvoiceXml().replace(
      '?>',
      '?>\n<?xml-stylesheet type="text/xsl" href="factura.xsl"?>',
    )
    expect(parseOk(xml).seriesNumber).toBe('F001-123')
  })

  it('rechaza un XML mayor al tope recibido por parámetro', () => {
    const xml = buildInvoiceXml()
    expect(parseError(xml, { maxLength: 100 }).code).toBe('XML_TOO_LARGE')
    expect(parseUblInvoice(xml, { maxLength: xml.length }).ok).toBe(true)
  })
})

/** Bytes ISO-8859-1 / windows-1252 de un texto con caracteres hasta U+00FF. */
const latin1Bytes = (text: string) => Uint8Array.from(text, (ch) => ch.charCodeAt(0))

describe('decodeXml', () => {
  it('el BOM UTF-8 manda sobre una codificación declarada distinta', () => {
    // Si se ignorara el BOM, la declaración ISO-8859-1 convertiría "Ñ" (C3 91) en "Ã" + U+0091.
    const bytes = new TextEncoder().encode(
      '\uFEFF<?xml version="1.0" encoding="ISO-8859-1"?><a>Ñ</a>',
    )
    const text = decodeXml(bytes)
    expect(text).toContain('<a>Ñ</a>')
    expect(text.startsWith('\uFEFF')).toBe(false)
  })

  it('respeta la codificación declarada (ISO-8859-1)', () => {
    const bytes = latin1Bytes('<?xml version="1.0" encoding="ISO-8859-1"?><a>Ñ</a>')
    expect(decodeXml(bytes)).toContain('<a>Ñ</a>')
  })

  it('decodifica UTF-8 en modo estricto y, si los bytes no son UTF-8, vuelve a windows-1252', () => {
    const declaredUtf8 = latin1Bytes('<?xml version="1.0" encoding="UTF-8"?><a>PEÑA</a>')
    expect(decodeXml(declaredUtf8)).toContain('<a>PEÑA</a>')
    const undeclared = latin1Bytes('<a>PEÑA</a>')
    expect(decodeXml(undeclared)).toBe('<a>PEÑA</a>')
  })

  it('una codificación declarada desconocida se lee como UTF-8', () => {
    const bytes = new TextEncoder().encode('<?xml version="1.0" encoding="NO-EXISTE"?><a>Ñ</a>')
    expect(decodeXml(bytes)).toContain('<a>Ñ</a>')
  })

  it('UTF-8 válido sin declaración se lee como UTF-8', () => {
    expect(decodeXml(new TextEncoder().encode('<a>Ñ €</a>'))).toBe('<a>Ñ €</a>')
  })
})

describe('parseUblInvoice · datos con formato inválido (XML_INVALID_FIELD)', () => {
  const cuotas = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `Cuota${String(i + 1).padStart(3, '0')}`,
      amount: '100.00',
      dueDate: '2026-11-30',
    }))

  it.each([
    [
      'serie y número de 5000 caracteres',
      { seriesNumber: `F001-${'1'.repeat(4995)}` },
      'seriesNumber',
      'serie y número',
    ],
    ['serie sin guion', { seriesNumber: 'F001123' }, 'seriesNumber', 'serie y número'],
    [
      'razón social del emisor de 200000 caracteres',
      { issuerName: 'A'.repeat(200_000) },
      'issuerName',
      'razón social del emisor',
    ],
    [
      'razón social del receptor de 1501 caracteres',
      { recipientName: 'B'.repeat(1501) },
      'recipientName',
      'razón social del receptor',
    ],
    ['101 cuotas', { installments: cuotas(101) }, 'installments', 'cuotas'],
    [
      'RUC del emisor que no es un número',
      { issuerRuc: 'no-es-un-ruc' },
      'issuerRuc',
      'RUC del emisor',
    ],
    [
      'RUC del receptor de 16 dígitos',
      { recipientRuc: '1'.repeat(16) },
      'recipientRuc',
      'RUC del receptor',
    ],
    ['moneda SOLES', { currency: 'SOLES' }, 'currency', 'moneda'],
    ['moneda en minúsculas', { currency: 'pen' }, 'currency', 'moneda'],
    [
      'tipo de comprobante de tres dígitos',
      { documentType: '001' },
      'documentType',
      'tipo de comprobante',
    ],
    ['total que no es un monto', { total: 'mucho' }, 'total', 'total'],
    [
      'fecha de emisión que no es ISO',
      { issueDate: '01/09/2026' },
      'issueDate',
      'fecha de emisión',
    ],
  ] as const)('%s', (_, options, key, field) => {
    const p = parseError(buildInvoiceXml(options))
    expect(p.code).toBe('XML_INVALID_FIELD')
    expect(p.field).toBe(key)
    expect(p.params).toEqual({ field })
    expect(p.message).toBe(`El dato "${field}" del XML no tiene un formato válido.`)
  })

  it('acepta los topes exactos: nombres de 1500 caracteres, 100 cuotas y RUC de 15 dígitos', () => {
    const inv = parseOk(
      buildInvoiceXml({
        issuerName: 'A'.repeat(1500),
        recipientName: 'B'.repeat(1500),
        installments: cuotas(100),
        recipientRuc: '1'.repeat(15),
        seriesNumber: 'FA01-12345678',
      }),
    )
    expect(inv.installments).toHaveLength(100)
    expect(inv.issuerName).toHaveLength(1500)
  })

  it('normaliza la serie y número a mayúsculas', () => {
    expect(parseOk(buildInvoiceXml({ seriesNumber: 'f001-123' })).seriesNumber).toBe('F001-123')
  })
})

describe('parseUblInvoice · cuotas y detracción mal formadas', () => {
  const invalidField = (xml: string) => {
    const p = parseError(xml)
    expect(p.code).toBe('XML_INVALID_FIELD')
    return p.params?.field
  }

  it('Cuota002 con fecha 30/08/2026', () => {
    const xml = buildInvoiceXml({
      installments: [
        { id: 'Cuota001', amount: '5000.00', dueDate: '2026-10-30' },
        { id: 'Cuota002', amount: '5620.00', dueDate: '30/08/2026' },
      ],
    })
    expect(invalidField(xml)).toBe('fecha de vencimiento de Cuota002')
  })

  it('Cuota001 con monto abc', () => {
    const xml = buildInvoiceXml({
      installments: [{ id: 'Cuota001', amount: 'abc', dueDate: '2026-11-30' }],
    })
    expect(invalidField(xml)).toBe('monto de Cuota001')
  })

  it('cuota con un identificador desmedido', () => {
    const xml = buildInvoiceXml({
      installments: [{ id: 'Cuota123456789', amount: '10620.00', dueDate: '2026-11-30' }],
    })
    expect(invalidField(xml)).toBe('cuotas')
  })

  it('cuota sin fecha de vencimiento', () => {
    const xml = buildInvoiceXml().replace('<cbc:PaymentDueDate>2026-11-30</cbc:PaymentDueDate>', '')
    expect(invalidField(xml)).toBe('fecha de vencimiento de Cuota001')
  })

  it('detracción con <PaymentPercent/> vacío: nunca vale 0', () => {
    const xml = buildInvoiceXml().replace(
      '<cbc:PaymentPercent>10</cbc:PaymentPercent>',
      '<cbc:PaymentPercent/>',
    )
    expect(invalidField(xml)).toBe('porcentaje de detracción')
  })

  it.each([
    ['porcentaje no numérico', { percent: 'diez', amount: '1180.00' }, 'porcentaje de detracción'],
    ['porcentaje mayor que 100', { percent: '120', amount: '1180.00' }, 'porcentaje de detracción'],
    ['monto inválido', { percent: '10', amount: '-5' }, 'monto de detracción'],
  ] as const)('detracción con %s', (_, detraction, field) => {
    expect(invalidField(buildInvoiceXml({ detraction }))).toBe(field)
  })

  it('lee un porcentaje de detracción con decimales', () => {
    const inv = parseOk(buildInvoiceXml({ detraction: { percent: '12.00', amount: '1416.00' } }))
    expect(inv.detraction).toEqual({ percent: 12, amount: '1416.00' })
  })

  it('un monto neto pendiente presente pero inválido no se descarta en silencio', () => {
    expect(invalidField(buildInvoiceXml({ netPendingAmount: 'abc' }))).toBe('monto neto pendiente')
  })
})

describe('parseUblInvoice · firma digital', () => {
  it('encuentra la firma en el segundo UBLExtension', () => {
    const inv = parseOk(buildInvoiceXml({ extensionBeforeSignature: true }))
    expect(inv.signed).toBe(true)
  })

  it('reconoce la firma por el cac:Signature de primer nivel', () => {
    const inv = parseOk(buildInvoiceXml({ signed: false, signatoryReference: true }))
    expect(inv.signed).toBe(true)
  })

  it('una extensión sin firma no cuenta como firmada', () => {
    const inv = parseOk(buildInvoiceXml({ signed: false, extensionBeforeSignature: true }))
    expect(inv.signed).toBe(false)
  })
})

describe('parseUblInvoice · CDATA', () => {
  it('lee el nombre dentro de CDATA sin decodificar entidades', () => {
    const xml = buildInvoiceXml({ cdataNames: true, issuerName: 'M &amp; M <S.A.C.>' })
    const inv = parseOk(xml)
    expect(inv.issuerName).toBe('M &amp; M <S.A.C.>')
    expect(inv.recipientName).toBe('SERVICIOS ENERGETICOS AMBIENTALES S.A.')
  })

  it('une texto y CDATA del mismo elemento: el texto se decodifica, el CDATA no', () => {
    const xml = buildInvoiceXml().replace(
      '<cbc:RegistrationName>PROVEEDOR EJEMPLO S.A.C.</cbc:RegistrationName>',
      '<cbc:RegistrationName>A &amp;<![CDATA[ B &amp; C]]></cbc:RegistrationName>',
    )
    expect(parseOk(xml).issuerName).toBe('A & B &amp; C')
  })

  /** Factura por defecto con la razón social del emisor reemplazada por `content` tal cual. */
  const withIssuerName = (content: string): string =>
    buildInvoiceXml().replace(
      '<cbc:RegistrationName>PROVEEDOR EJEMPLO S.A.C.</cbc:RegistrationName>',
      `<cbc:RegistrationName>${content}</cbc:RegistrationName>`,
    )

  it('conserva el orden del texto y del CDATA dentro del elemento', () => {
    expect(parseOk(withIssuerName('A<![CDATA[B]]>C')).issuerName).toBe('ABC')
  })

  it('un CDATA al inicio seguido de texto con entidades se lee en orden y decodificado', () => {
    const inv = parseOk(withIssuerName('<![CDATA[CONSTRUCTORA]]> PEÑA &amp; HIJOS'))
    expect(inv.issuerName).toBe('CONSTRUCTORA PEÑA & HIJOS')
  })

  it('el contenido del CDATA es literal: ni sus entidades ni sus "<" se interpretan', () => {
    expect(parseOk(withIssuerName('<![CDATA[A &amp; B]]>')).issuerName).toBe('A &amp; B')
    expect(parseOk(withIssuerName('<![CDATA[x < y]]>')).issuerName).toBe('x < y')
    expect(parseOk(withIssuerName('<![CDATA[&#65; > &lt;]]>')).issuerName).toBe('&#65; > &lt;')
  })

  it('un "]]>" partido en dos secciones CDATA se lee completo', () => {
    const inv = parseOk(buildInvoiceXml({ cdataNames: true, issuerName: 'X ]]> & <Y>' }))
    expect(inv.issuerName).toBe('X ]]> & <Y>')
  })

  it('un "<![CDATA[" dentro de un comentario, una instrucción o un atributo no abre una sección', () => {
    const xml = buildInvoiceXml({ cdataNames: true })
      .replace('<cac:AccountingSupplierParty>', '<cac:AccountingSupplierParty><!-- <![CDATA[ -->')
      .replace('<cac:AccountingCustomerParty>', '<cac:AccountingCustomerParty><?nota <![CDATA[ ?>')
      .replace('<cbc:ID schemeID="6">', '<cbc:ID schemeID="6" nota="<![CDATA[x]]>">')
    const inv = parseOk(xml)
    expect(inv.issuerRuc).toBe('20100070970')
    expect(inv.issuerName).toBe('PROVEEDOR EJEMPLO S.A.C.')
    expect(inv.recipientRuc).toBe('20131312955')
    expect(inv.recipientName).toBe('SERVICIOS ENERGETICOS AMBIENTALES S.A.')
  })

  it('un CDATA fuera del elemento raíz es XML ilegible, como el texto fuera de la raíz', () => {
    const xml = buildInvoiceXml()
    const [prolog = '', rest = ''] = xml.split(/(?<=\?>)/, 2)
    for (const malformed of [
      `${prolog}<![CDATA[x]]>${rest}`,
      `${prolog}\n<!-- nota -->\n<![CDATA[x]]>${rest}`,
      `${xml}<![CDATA[x]]>`,
      '<Invoice/><![CDATA[x]]>',
      `${prolog}<Invoice><cbc:Vacio/><cbc:Vacio nota="/>" /></Invoice><![CDATA[x]]>`,
    ]) {
      expect(parseError(malformed).code, malformed.slice(0, 80)).toBe('UNREADABLE_XML')
    }
    // Lo que sí puede ir fuera de la raíz se sigue aceptando: espacios, comentarios e instrucciones.
    expect(parseOk(`${xml}\n<!-- fin <![CDATA[ -->\n<?nota x?>\n`).seriesNumber).toBe('F001-123')
  })

  it('un "<!" que no abre un comentario ni un CDATA es XML ilegible', () => {
    // El validador los deja pasar y el parser tomaría `<![CDATX[` como CDATA y `<!X>` como elemento.
    for (const content of [
      'A<![CDATX[B &amp; C]]>D',
      'A<![INCLUDE[B]]>C',
      'A<!X>B',
      '<!ELEMENT x>',
    ]) {
      expect(parseError(withIssuerName(content)).code, content).toBe('UNREADABLE_XML')
    }
  })
})

describe('parseUblInvoice · propiedad: nunca lanza', () => {
  /** Todo texto de lo leído, a cualquier profundidad (nombres, ids de cuota, fechas…). */
  const textsOf = (value: unknown): string[] => {
    if (typeof value === 'string') return [value]
    if (value === null || typeof value !== 'object') return []
    return Object.values(value).flatMap(textsOf)
  }

  /**
   * Nunca lanza, y si lee la factura, lo leído cumple `parsedInvoiceSchema` y ningún texto lleva un
   * carácter que XML no admite (U+0000, que PostgreSQL no guarda, ni un sustituto suelto).
   */
  const wellBehaved = (xml: string): boolean => {
    let r: ParseResult
    try {
      r = parseUblInvoice(xml)
    } catch {
      return false
    }
    return r.ok
      ? parsedInvoiceSchema.safeParse(r.invoice).success && textsOf(r.invoice).every(isXmlText)
      : typeof r.problem.code === 'string'
  }

  it('con cadenas arbitrarias', () => {
    fc.assert(fc.property(fc.string({ unit: 'binary', maxLength: 500 }), wellBehaved), {
      numRuns: 500,
    })
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (tail) =>
        wellBehaved(`<?xml version="1.0"?><Invoice>${tail}</Invoice>`),
      ),
      { numRuns: 500 },
    )
  })

  const base = buildInvoiceXml({
    extensionBeforeSignature: true,
    signatoryReference: true,
    installments: [
      { id: 'Cuota001', amount: '5000.00', dueDate: '2026-10-30' },
      { id: 'Cuota002', amount: '5620.00', dueDate: '2026-11-30' },
    ],
  })

  const fragment = fc.oneof(
    fc.string({ maxLength: 20 }),
    fc.string({ unit: 'binary', maxLength: 10 }),
    fc.constantFrom(
      '<',
      '>',
      '&',
      '&amp;',
      '&#0;',
      '&#x110000;',
      '&#xD800;',
      '&#1;',
      '\u0000',
      '\uD800',
      '\uFFFE',
      '<![CDATA[',
      ']]>',
      '<!DOCTYPE x>',
      '<?pi x?>',
      '<cbc:ID>',
      '</cbc:ID>',
      '<cac:PaymentTerms>',
      '"',
      '\uFEFF',
      '9'.repeat(40),
      'Cuota999',
      'Detraccion',
    ),
  )

  type Mutation =
    | { kind: 'delete'; at: number; length: number }
    | { kind: 'insert'; at: number; text: string }
    | { kind: 'duplicate'; at: number; length: number }
    | { kind: 'text'; nth: number; text: string }

  const mutation: fc.Arbitrary<Mutation> = fc.oneof(
    fc.record({
      kind: fc.constant('delete' as const),
      at: fc.nat(),
      length: fc.integer({ min: 1, max: 40 }),
    }),
    fc.record({ kind: fc.constant('insert' as const), at: fc.nat(), text: fragment }),
    fc.record({
      kind: fc.constant('duplicate' as const),
      at: fc.nat(),
      length: fc.integer({ min: 1, max: 300 }),
    }),
    fc.record({ kind: fc.constant('text' as const), nth: fc.nat(), text: fragment }),
  )

  const apply = (xml: string, m: Mutation): string => {
    if (m.kind === 'text') {
      // Reemplaza el contenido de texto del n-ésimo elemento hoja.
      const leaves = [...xml.matchAll(/>([^<>]*)</g)]
      const target = leaves[m.nth % Math.max(leaves.length, 1)]
      if (target?.index === undefined) return xml
      const start = target.index + 1
      return xml.slice(0, start) + m.text + xml.slice(start + (target[1] ?? '').length)
    }
    const at = m.at % (xml.length + 1)
    if (m.kind === 'delete') return xml.slice(0, at) + xml.slice(at + m.length)
    if (m.kind === 'insert') return xml.slice(0, at) + m.text + xml.slice(at)
    return xml.slice(0, at) + xml.slice(at, at + m.length) + xml.slice(at)
  }

  it('con XML de la fábrica mutado', () => {
    fc.assert(
      fc.property(fc.array(mutation, { minLength: 1, maxLength: 6 }), (mutations) =>
        wellBehaved(mutations.reduce(apply, base)),
      ),
      { numRuns: 1000 },
    )
  })

  it('decodeXml nunca lanza con bytes arbitrarios', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 300 }),
        (bytes) => typeof decodeXml(bytes) === 'string',
      ),
    )
  })
})
