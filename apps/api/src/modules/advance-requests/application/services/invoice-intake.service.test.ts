import type { Amount } from '@anticipate/shared/money'
import { buildInvoiceXml, type TestXmlOptions } from '@anticipate/shared/testing'
import { describe, expect, it } from 'vitest'
import type {
  InvoiceIntakeInput,
  UploadedFile,
} from '#/modules/advance-requests/domain/types/invoice-intake.types.js'
import type { PayerConditions } from '#/modules/advance-requests/domain/types/payer-conditions.js'
import { InvoiceIntakeService } from './invoice-intake.service.js'

const MB = 1024 * 1024
const LIMITS = { maxXmlBytes: MB, maxPdfBytes: 10 * MB }

const sea: PayerConditions = {
  payerId: '0199a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b',
  slug: 'sea',
  ruc: '20131312955',
  shortName: 'SEA',
  advancePercent: 80,
  minTermDays: 15,
  maxInvoices: 10,
  allowedCurrencies: ['PEN', 'USD'],
}

const upload = (originalname: string, content: string | Buffer): UploadedFile => {
  const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
  return { originalname, buffer, size: buffer.length }
}
const xml = (originalname: string, options: TestXmlOptions = {}) =>
  upload(originalname, buildInvoiceXml(options))
const pdf = (originalname: string) =>
  upload(originalname, '%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n')

const input = (overrides: Partial<InvoiceIntakeInput> = {}): InvoiceIntakeInput => ({
  payer: sea,
  supplierRuc: '20100070970',
  today: '2026-09-24',
  requestedAmount: '8000.00' as Amount,
  xmlFiles: [xml('F001-123.xml')],
  pdfFiles: [],
  ...overrides,
})

const service = new InvoiceIntakeService(LIMITS)

describe('InvoiceIntakeService', () => {
  it('acepta una factura válida con su PDF y calcula el máximo con el porcentaje del pagador', async () => {
    const xmlFile = xml('F001-123.xml')
    const pdfFile = pdf('f001-123.PDF')
    const result = await service.evaluate(input({ xmlFiles: [xmlFile], pdfFiles: [pdfFile] }))
    expect(result).toEqual({
      ok: true,
      invoices: [
        {
          invoice: expect.objectContaining({
            seriesNumber: 'F001-123',
            netPendingAmount: '10620.00',
          }),
          key: '20100070970|F001-123',
          xml: xmlFile,
          pdf: pdfFile,
        },
      ],
      currency: 'PEN',
      totalNetPending: '10620.00',
      maxAmount: '8496.00',
    })
  })

  it('una factura sin PDF queda con pdf null y las facturas conservan el orden recibido', async () => {
    const result = await service.evaluate(
      input({
        xmlFiles: [xml('F001-124.xml', { seriesNumber: 'F001-124' }), xml('F001-123.xml')],
        pdfFiles: [pdf('F001-123.pdf')],
        requestedAmount: '16992.00' as Amount,
      }),
    )
    if (!result.ok) throw new Error(JSON.stringify(result.problems))
    expect(result.invoices.map((i) => [i.key, i.pdf?.originalname ?? null])).toEqual([
      ['20100070970|F001-124', null],
      ['20100070970|F001-123', 'F001-123.pdf'],
    ])
    expect(result.totalNetPending).toBe('21240.00')
    expect(result.maxAmount).toBe('16992.00')
  })

  it('lee cada XML en el orden recibido; uno ilegible no impide leer los demás', async () => {
    const result = await service.evaluate(
      input({
        xmlFiles: [
          xml('F001-2.xml', { seriesNumber: 'F001-2' }),
          upload('roto.xml', '%PDF-1.7 no soy xml'),
          xml('F001-1.xml', { seriesNumber: 'F001-1', currency: 'EUR' }),
        ],
      }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems.map((p) => [p.code, p.file ?? p.invoice])).toEqual([
      ['UNREADABLE_XML', 'roto.xml'],
      ['CURRENCY_NOT_ALLOWED', 'F001-1'],
    ])
  })

  it('cede el turno al event loop antes de cada XML: nunca lee dos seguidos sin soltarlo', async () => {
    // Leer un XML de 1 MiB armado a propósito (miles de etiquetas o atributos distintos) lleva medio
    // segundo o más de CPU; leer los 20 de una petición de corrido bloquearía el proceso entero
    // (otras solicitudes y la sonda de vida) de 13 a 30 s. Aquí se registra cuándo se lee cada
    // archivo (el acceso a su contenido) y cada vuelta del event loop (un setImmediate que se
    // reprograma).
    const events: string[] = []
    const tracked = (name: string, seriesNumber: string): UploadedFile => {
      const file = xml(name, { seriesNumber })
      return {
        originalname: name,
        size: file.size,
        get buffer() {
          events.push(name)
          return file.buffer
        },
      }
    }
    let running = true
    const tick = () => {
      if (!running) return
      events.push('tick')
      setImmediate(tick)
    }
    setImmediate(tick)
    const result = await service.evaluate(
      input({
        xmlFiles: [
          tracked('F001-1.xml', 'F001-1'),
          tracked('F001-2.xml', 'F001-2'),
          tracked('F001-3.xml', 'F001-3'),
        ],
        requestedAmount: '1.00' as Amount,
      }),
    )
    running = false
    const seen = [...events]
    expect(result.ok).toBe(true)
    expect(seen.filter((event) => event !== 'tick')).toEqual([
      'F001-1.xml',
      'F001-2.xml',
      'F001-3.xml',
    ])
    // Entre dos lecturas siempre corrió el event loop.
    expect(seen.join(' ')).toMatch(/F001-1\.xml( tick)+ F001-2\.xml( tick)+ F001-3\.xml/)
  })

  it('una fecha de emisión en el año 0000, que PostgreSQL no guarda, es un 422 con el archivo', async () => {
    const result = await service.evaluate(
      input({ xmlFiles: [xml('F001-123.xml', { issueDate: '0000-01-01' })] }),
    )
    expect(result).toEqual({
      ok: false,
      problems: [
        expect.objectContaining({
          code: 'XML_INVALID_FIELD',
          field: 'issueDate',
          file: 'F001-123.xml',
        }),
      ],
    })
  })

  it('junta en una sola respuesta los problemas de lectura, de emparejamiento y de reglas', async () => {
    const result = await service.evaluate(
      input({
        xmlFiles: [
          xml('F001-1.xml', { seriesNumber: 'F001-1', recipientRuc: '20100070970' }),
          upload('F001-2.xml', '%PDF-1.7 no soy xml'),
        ],
        pdfFiles: [upload('F001-1.pdf', 'tampoco soy pdf'), pdf('F001-9.pdf')],
      }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems.map((p) => [p.code, p.file ?? p.invoice])).toEqual([
      ['UNREADABLE_XML', 'F001-2.xml'],
      ['INVALID_PDF', 'F001-1.pdf'],
      ['PDF_WITHOUT_XML', 'F001-9.pdf'],
      ['RECIPIENT_IS_NOT_PAYER', 'F001-1'],
    ])
  })

  it('si ningún XML se pudo leer, no agrega NO_INVOICES', async () => {
    const result = await service.evaluate(
      input({ xmlFiles: [upload('a.xml', 'hola'), upload('b.xml', '<a>')] }),
    )
    expect(result).toEqual({
      ok: false,
      problems: [
        expect.objectContaining({ code: 'UNREADABLE_XML', file: 'a.xml' }),
        expect.objectContaining({ code: 'UNREADABLE_XML', file: 'b.xml' }),
      ],
    })
  })

  it('sin ningún XML responde NO_INVOICES', async () => {
    const result = await service.evaluate(input({ xmlFiles: [] }))
    expect(result).toEqual({
      ok: false,
      problems: [expect.objectContaining({ code: 'NO_INVOICES' })],
    })
  })

  it('aplica los topes por archivo con el nombre de cada uno', async () => {
    const small = new InvoiceIntakeService({ maxXmlBytes: 100, maxPdfBytes: 20 })
    const result = await small.evaluate(
      input({ xmlFiles: [xml('F001-123.xml')], pdfFiles: [pdf('F001-123.pdf')] }),
    )
    expect(result).toEqual({
      ok: false,
      problems: [
        expect.objectContaining({ code: 'XML_TOO_LARGE', file: 'F001-123.xml' }),
        expect.objectContaining({ code: 'FILE_TOO_LARGE', file: 'F001-123.pdf' }),
      ],
    })
  })

  it('un monto mayor al máximo es AMOUNT_EXCEEDS_MAXIMUM con el máximo en el mensaje', async () => {
    const result = await service.evaluate(input({ requestedAmount: '8496.01' as Amount }))
    expect(result).toEqual({
      ok: false,
      problems: [
        expect.objectContaining({
          code: 'AMOUNT_EXCEEDS_MAXIMUM',
          field: 'requestedAmount',
          params: { max: '8496.00', currency: 'PEN' },
        }),
      ],
    })
  })

  it('con facturas inválidas no valida el monto: no agrega NO_MAXIMUM_AVAILABLE', async () => {
    const result = await service.evaluate(
      input({
        xmlFiles: [xml('F001-123.xml', { currency: 'EUR' })],
        requestedAmount: '1.00' as Amount,
      }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems.map((p) => p.code)).toEqual(['CURRENCY_NOT_ALLOWED'])
  })

  it('usa el máximo de facturas del pagador', async () => {
    const result = await service.evaluate(
      input({
        payer: { ...sea, maxInvoices: 1 },
        xmlFiles: [xml('F001-123.xml'), xml('F001-124.xml', { seriesNumber: 'F001-124' })],
      }),
    )
    expect(result).toEqual({
      ok: false,
      problems: [expect.objectContaining({ code: 'TOO_MANY_INVOICES', params: { max: 1 } })],
    })
  })

  it('el máximo de facturas cuenta los XML recibidos, también los que no se pudieron leer', async () => {
    const result = await service.evaluate(
      input({
        payer: { ...sea, maxInvoices: 1 },
        xmlFiles: [xml('a.xml'), upload('b.xml', 'no soy xml')],
      }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems.map((p) => [p.code, p.file ?? null])).toEqual([
      ['UNREADABLE_XML', 'b.xml'],
      ['TOO_MANY_INVOICES', null],
    ])
  })

  it('con más XML que el máximo y ninguno legible, informa cada archivo y el máximo', async () => {
    const result = await service.evaluate(
      input({
        payer: { ...sea, maxInvoices: 1 },
        xmlFiles: [upload('a.xml', 'hola'), upload('b.xml', '<a>')],
      }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems.map((p) => [p.code, p.file ?? null])).toEqual([
      ['UNREADABLE_XML', 'a.xml'],
      ['UNREADABLE_XML', 'b.xml'],
      ['TOO_MANY_INVOICES', null],
    ])
  })

  it('con más XML que el máximo informa también los problemas de cada factura, en una sola respuesta', async () => {
    const result = await service.evaluate(
      input({
        payer: { ...sea, maxInvoices: 1 },
        xmlFiles: [
          xml('F001-1.xml', { seriesNumber: 'F001-1', recipientRuc: '20100070970' }),
          xml('F001-2.xml', { seriesNumber: 'F001-2', currency: 'EUR' }),
        ],
        pdfFiles: [pdf('F001-9.pdf')],
      }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems.map((p) => [p.code, p.file ?? p.invoice ?? null])).toEqual([
      ['PDF_WITHOUT_XML', 'F001-9.pdf'],
      ['TOO_MANY_INVOICES', null],
      ['RECIPIENT_IS_NOT_PAYER', 'F001-1'],
      ['CURRENCY_NOT_ALLOWED', 'F001-2'],
    ])
  })

  it('un XML con U+0000 en la razón social es UNREADABLE_XML con su nombre: 422, nunca un INSERT que falle', async () => {
    const result = await service.evaluate(
      input({ xmlFiles: [xml('F001-123.xml', { issuerName: 'PROV\u0000EEDOR' })] }),
    )
    expect(result).toEqual({
      ok: false,
      problems: [expect.objectContaining({ code: 'UNREADABLE_XML', file: 'F001-123.xml' })],
    })
  })

  it('lo aceptado nunca lleva un carácter que PostgreSQL no guarda ni un sustituto suelto', async () => {
    const result = await service.evaluate(
      input({
        xmlFiles: [
          upload(
            'F001-123.xml',
            buildInvoiceXml().replace(
              '>PROVEEDOR EJEMPLO S.A.C.<',
              '>PROVEEDOR &#0; &#xD800; &#1; S.A.C.<',
            ),
          ),
        ],
      }),
    )
    if (!result.ok) throw new Error(JSON.stringify(result.problems))
    const name = result.invoices[0]?.invoice.issuerName ?? ''
    expect(name).toBe('PROVEEDOR &#0; &#xD800; &#1; S.A.C.')
    const codePoints = [...name].map((ch) => ch.codePointAt(0) ?? 0)
    expect(codePoints.filter((cp) => cp < 0x20 || (cp >= 0xd800 && cp <= 0xdfff))).toEqual([])
  })

  it('aplica la regla de la fecha de emisión futura (hoy es el de la solicitud)', async () => {
    const result = await service.evaluate(
      input({ xmlFiles: [xml('F001-123.xml', { issueDate: '2026-09-25' })] }),
    )
    expect(result).toEqual({
      ok: false,
      problems: [expect.objectContaining({ code: 'ISSUE_DATE_IN_FUTURE', invoice: 'F001-123' })],
    })
  })

  it('aplica las reglas gemelas de las CHECK de facturas: 422 y nunca un INSERT que falle', async () => {
    const result = await service.evaluate(
      input({
        xmlFiles: [
          xml('F001-123.xml', {
            total: '100.00',
            netPendingAmount: '200.00',
            installments: [{ id: 'Cuota001', amount: '200.00', dueDate: '2026-11-30' }],
          }),
          xml('F001-124.xml', {
            seriesNumber: 'F001-124',
            installments: [
              { id: 'Cuota001', amount: '10620.00', dueDate: '2026-11-30' },
              { id: 'Cuota002', amount: '0.00', dueDate: '2026-12-30' },
            ],
          }),
        ],
      }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems.map((p) => [p.code, p.invoice])).toEqual([
      ['NET_PENDING_EXCEEDS_TOTAL', 'F001-123'],
      ['INSTALLMENT_AMOUNT_ZERO', 'F001-124'],
    ])
  })

  it('una factura repetida en la misma solicitud es DUPLICATE_INVOICE', async () => {
    const result = await service.evaluate(
      input({
        xmlFiles: [xml('F001-123.xml'), xml('copia.xml', { seriesNumber: 'F001-00000123' })],
      }),
    )
    expect(result).toEqual({
      ok: false,
      problems: [expect.objectContaining({ code: 'DUPLICATE_INVOICE', invoice: 'F001-00000123' })],
    })
  })

  it('un pagador mal configurado es un error de la plataforma, no un problema del proveedor', async () => {
    await expect(service.evaluate(input({ payer: { ...sea, advancePercent: 0 } }))).rejects.toThrow(
      RangeError,
    )
  })

  it.each([
    [{ maxXmlBytes: 0, maxPdfBytes: MB }],
    [{ maxXmlBytes: MB, maxPdfBytes: -1 }],
    [{ maxXmlBytes: 1.5, maxPdfBytes: MB }],
    [{ maxXmlBytes: MB, maxPdfBytes: Number.POSITIVE_INFINITY }],
  ])('rechaza topes de archivo inválidos (%o)', (limits) => {
    expect(() => new InvoiceIntakeService(limits)).toThrow(RangeError)
  })
})
