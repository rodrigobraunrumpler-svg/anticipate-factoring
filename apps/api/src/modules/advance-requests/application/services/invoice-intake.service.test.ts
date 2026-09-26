import { monitorEventLoopDelay } from 'node:perf_hooks'
import { problemSchema } from '@anticipate/shared/errors'
import type { Amount } from '@anticipate/shared/money'
import { buildInvoiceXml, type TestXmlOptions } from '@anticipate/shared/testing'
import { afterAll, describe, expect, it } from 'vitest'
import { ServiceUnavailableError } from '#/common/exceptions/index.js'
import { WorkerThreadsInvoiceXmlParser } from '#/infrastructure/invoice-xml/worker-threads/index.js'
import type {
  InvoiceXmlParseOutcome,
  InvoiceXmlParserPort,
} from '#/modules/advance-requests/application/ports/invoice-xml-parser.port.js'
import type {
  InvoiceIntakeInput,
  UploadedFile,
} from '#/modules/advance-requests/domain/types/invoice-intake.types.js'
import type { PayerConditions } from '#/modules/advance-requests/domain/types/payer-conditions.js'
import { InlineInvoiceXmlParser } from '../../../../../test/support/fakes.js'
import { hostileInvoiceXml } from '../../../../../test/support/hostile-xml.js'
import { InvoiceIntakeService } from './invoice-intake.service.js'

const MB = 1024 * 1024
const LIMITS = { maxXmlBytes: MB, maxPdfBytes: 10 * MB }

// El lector de producción: cada XML se lee en un worker_thread, así estos tests fijan también que la
// lectura fuera del hilo principal responde exactamente lo mismo que antes. Plazos holgados: aquí
// ningún XML debe pasarlos, ni siquiera en una máquina cargada.
const parser = new WorkerThreadsInvoiceXmlParser({
  workers: 2,
  timeoutMs: 30_000,
  workerHeapMb: 128,
  queueLimit: 32,
  queueTimeoutMs: 60_000,
})
afterAll(() => parser.close())

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

const service = new InvoiceIntakeService(LIMITS, parser)

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
    expect(result.problems.map((p) => [p.code, p.file, p.invoice ?? null])).toEqual([
      ['UNREADABLE_XML', 'roto.xml', null],
      ['CURRENCY_NOT_ALLOWED', 'F001-1.xml', 'F001-1'],
    ])
  })

  it('XML hostiles de 1 MiB nunca bloquean el event loop: el bloqueo más largo queda bajo 50 ms', async () => {
    // Etiquetas vacías con nombres distintos: XML válido que el lector tarda medio segundo o más en
    // recorrer (la medición de la Tarea 11). En el hilo principal, cada uno bloqueaba ese tiempo.
    const content = hostileInvoiceXml()
    const xmlFiles = Array.from({ length: 4 }, (_, i) => upload(`hostil-${i}.xml`, content))
    const histogram = monitorEventLoopDelay({ resolution: 1 })
    histogram.enable()
    const result = await service.evaluate(input({ xmlFiles }))
    histogram.disable()
    expect(result).toEqual({
      ok: false,
      problems: xmlFiles.map((file) =>
        expect.objectContaining({ code: 'XML_MISSING_REQUIRED_FIELD', file: file.originalname }),
      ),
    })
    expect(histogram.max / 1e6).toBeLessThan(50)
  }, 30_000)

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
    expect(result.problems.map((p) => [p.code, p.file, p.invoice ?? null])).toEqual([
      ['UNREADABLE_XML', 'F001-2.xml', null],
      ['INVALID_PDF', 'F001-1.pdf', null],
      ['PDF_WITHOUT_XML', 'F001-9.pdf', null],
      ['RECIPIENT_IS_NOT_PAYER', 'F001-1.xml', 'F001-1'],
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
    const small = new InvoiceIntakeService({ maxXmlBytes: 100, maxPdfBytes: 20 }, parser)
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
    expect(result.problems.map((p) => [p.code, p.file ?? null, p.invoice ?? null])).toEqual([
      ['PDF_WITHOUT_XML', 'F001-9.pdf', null],
      ['TOO_MANY_INVOICES', null, null],
      ['RECIPIENT_IS_NOT_PAYER', 'F001-1.xml', 'F001-1'],
      ['CURRENCY_NOT_ALLOWED', 'F001-2.xml', 'F001-2'],
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
      problems: [
        expect.objectContaining({
          code: 'ISSUE_DATE_IN_FUTURE',
          invoice: 'F001-123',
          file: 'F001-123.xml',
        }),
      ],
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
    expect(result.problems.map((p) => [p.code, p.invoice, p.file])).toEqual([
      ['NET_PENDING_EXCEEDS_TOTAL', 'F001-123', 'F001-123.xml'],
      ['INSTALLMENT_AMOUNT_ZERO', 'F001-124', 'F001-124.xml'],
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
      problems: [
        expect.objectContaining({
          code: 'DUPLICATE_INVOICE',
          invoice: 'F001-00000123',
          file: 'copia.xml',
        }),
      ],
    })
  })

  it('cada problema de una factura lleva el XML que la trajo, aunque dos archivos traigan la misma serie', async () => {
    const result = await service.evaluate(
      input({
        xmlFiles: [
          xml('a.xml', { seriesNumber: 'F001-1' }),
          xml('b.xml', { seriesNumber: 'F001-1' }),
          xml('c.xml', { seriesNumber: 'F001-1', issuerRuc: '10467286736' }),
        ],
      }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems.map((p) => [p.code, p.invoice, p.file])).toEqual([
      ['DUPLICATE_INVOICE', 'F001-1', 'b.xml'],
      ['ISSUER_IS_NOT_SUPPLIER', 'F001-1', 'c.xml'],
    ])
  })

  it('dos XML con el mismo nombre y un PDF: 422 DUPLICATE_FILE_NAME, nunca el PDF en otra factura', async () => {
    // a/factura.xml y b/factura.xml llegan como factura.xml: el PDF no puede ir a ninguna de las dos.
    const result = await service.evaluate(
      input({
        xmlFiles: [
          xml('factura.xml', { seriesNumber: 'F001-2' }),
          xml('factura.xml', { seriesNumber: 'F001-1' }),
        ],
        pdfFiles: [pdf('factura.pdf')],
      }),
    )
    expect(result).toEqual({
      ok: false,
      problems: [
        expect.objectContaining({
          code: 'DUPLICATE_FILE_NAME',
          file: 'factura.xml',
          params: { file: 'factura.xml' },
        }),
      ],
    })
  })

  it('dos XML con el mismo nombre y un PDF para cada uno: ningún PDF es PDF_WITHOUT_XML', async () => {
    const result = await service.evaluate(
      input({
        xmlFiles: [
          xml('F001-1.xml', { seriesNumber: 'F001-1' }),
          xml('f001-1.XML', { seriesNumber: 'F001-2' }),
        ],
        pdfFiles: [pdf('F001-1.pdf'), pdf('f001-1.pdf')],
      }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems.map((p) => [p.code, p.file])).toEqual([
      ['DUPLICATE_FILE_NAME', 'F001-1.xml'],
      ['DUPLICATE_FILE_NAME', 'f001-1.XML'],
    ])
  })

  it('los XML con el mismo nombre se leen y validan igual: sus demás problemas salen en la misma respuesta', async () => {
    const result = await service.evaluate(
      input({
        xmlFiles: [
          xml('factura.xml', { seriesNumber: 'F001-1', currency: 'EUR' }),
          upload('Factura.xml', 'no soy xml'),
        ],
      }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems.map((p) => [p.code, p.file])).toEqual([
      ['UNREADABLE_XML', 'Factura.xml'],
      ['DUPLICATE_FILE_NAME', 'factura.xml'],
      ['DUPLICATE_FILE_NAME', 'Factura.xml'],
      ['CURRENCY_NOT_ALLOWED', 'factura.xml'],
    ])
  })

  it('un problema de un PDF no oculta un monto mayor al máximo: los PDF no cambian las facturas', async () => {
    const result = await service.evaluate(
      input({ pdfFiles: [pdf('F001-9.pdf')], requestedAmount: '8496.01' as Amount }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems.map((p) => [p.code, p.file ?? p.field])).toEqual([
      ['PDF_WITHOUT_XML', 'F001-9.pdf'],
      ['AMOUNT_EXCEEDS_MAXIMUM', 'requestedAmount'],
    ])
  })

  it('XML con nombres repetidos tampoco ocultan un monto mayor al máximo', async () => {
    const result = await service.evaluate(
      input({
        xmlFiles: [
          xml('factura.xml', { seriesNumber: 'F001-1' }),
          xml('factura.xml', { seriesNumber: 'F001-2' }),
        ],
        requestedAmount: '16992.01' as Amount,
      }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems.map((p) => p.code)).toEqual([
      'DUPLICATE_FILE_NAME',
      'AMOUNT_EXCEEDS_MAXIMUM',
    ])
  })

  describe('nombres de archivo: el 422 nunca repite uno sin tope ni con controles', () => {
    /** Un XML válido cuyo contenido registra si alguien lo leyó. */
    const watched = (originalname: string, reads: string[]): UploadedFile => {
      const file = xml('F001-123.xml')
      return {
        originalname,
        size: file.size,
        get buffer() {
          reads.push(originalname)
          return file.buffer
        },
      }
    }
    const shortened = `${'x'.repeat(64)}…`

    it('un XML con un nombre sin tope es INVALID_FILE_NAME: no se lee y el nombre sale acortado', async () => {
      const reads: string[] = []
      const long = `${'x'.repeat(16_000)}.xml`
      const result = await service.evaluate(
        input({
          xmlFiles: [watched(long, reads), xml('F001-124.xml', { seriesNumber: 'F001-124' })],
        }),
      )
      expect(reads).toEqual([])
      expect(result).toEqual({
        ok: false,
        problems: [
          {
            code: 'INVALID_FILE_NAME',
            message: `El archivo «${shortened}» tiene un nombre que no podemos usar: debe tener hasta 255 caracteres y ningún carácter de control. Cámbiale el nombre y vuelve a adjuntarlo.`,
            params: { file: shortened, max: 255 },
          },
        ],
      })
      expect(JSON.stringify(result).length).toBeLessThan(512)
    })

    it('el tope es de 255 unidades UTF-16: con 255 el nombre se repite tal cual, con 256 no', async () => {
      const atMax = `${'a'.repeat(251)}.xml`
      const over = `${'b'.repeat(252)}.xml`
      const result = await service.evaluate(
        input({
          xmlFiles: [
            xml(atMax, { seriesNumber: 'F001-1', currency: 'EUR' }),
            xml(over, { seriesNumber: 'F001-2', currency: 'EUR' }),
          ],
        }),
      )
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.problems.map((p) => [p.code, p.file ?? null, p.params?.file ?? null])).toEqual([
        ['INVALID_FILE_NAME', null, `${'b'.repeat(64)}…`],
        ['CURRENCY_NOT_ALLOWED', atMax, null],
      ])
    })

    it.each([
      ['U+0000', 'F001-123\u0000.xml'],
      ['un salto de línea', 'F001-123\n.xml'],
      ['un control C1', 'F001-123\u0085.xml'],
      ['un sustituto suelto', 'F001-123\uD800.xml'],
    ])('un XML con %s en el nombre es INVALID_FILE_NAME y no se lee', async (_, name) => {
      const reads: string[] = []
      const result = await service.evaluate(input({ xmlFiles: [watched(name, reads)] }))
      expect(reads).toEqual([])
      expect(result).toEqual({
        ok: false,
        problems: [
          expect.objectContaining({
            code: 'INVALID_FILE_NAME',
            params: { file: 'F001-123\uFFFD.xml', max: 255 },
          }),
        ],
      })
    })

    it('un PDF con un nombre inválido: solo INVALID_FILE_NAME, no se empareja y no oculta el monto', async () => {
      const result = await service.evaluate(
        input({
          pdfFiles: [
            upload('F001-123\u0001.pdf', 'no soy pdf'),
            upload('x'.repeat(300), 'tampoco'),
          ],
          requestedAmount: '8496.01' as Amount,
        }),
      )
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.problems.map((p) => [p.code, p.file ?? null, p.params?.file ?? null])).toEqual([
        ['INVALID_FILE_NAME', null, 'F001-123\uFFFD.pdf'],
        ['INVALID_FILE_NAME', null, shortened],
        ['AMOUNT_EXCEEDS_MAXIMUM', null, null],
      ])
    })

    it('un XML con un nombre inválido no entra al emparejamiento ni a los nombres repetidos', async () => {
      // Sin espacios alrededor y en minúsculas, su nombre base sería el de factura.xml.
      const padded = `${' '.repeat(300)}FACTURA.xml`
      const result = await service.evaluate(
        input({
          xmlFiles: [xml(padded, { seriesNumber: 'F001-9' }), xml('factura.xml')],
          pdfFiles: [pdf('factura.pdf')],
        }),
      )
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.problems.map((p) => [p.code, p.file ?? null])).toEqual([
        ['INVALID_FILE_NAME', null],
      ])
    })

    it('el máximo de facturas cuenta también los XML con un nombre inválido', async () => {
      const result = await service.evaluate(
        input({
          payer: { ...sea, maxInvoices: 1 },
          xmlFiles: [xml('F001-123.xml'), xml('x'.repeat(300), { seriesNumber: 'F001-124' })],
        }),
      )
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.problems.map((p) => p.code)).toEqual(['INVALID_FILE_NAME', 'TOO_MANY_INVOICES'])
    })

    /**
     * Peor caso para el tamaño del 422: los 20 archivos de UPLOAD_MAX_FILES son XML con cien cuotas
     * vencidas y en cero y todo otro dato inválido. Son unos doscientos problemas por factura, y cada
     * uno repite el nombre de su XML en `file`.
     */
    const worstCase = (name: (index: number) => string): UploadedFile[] => {
      const installments = Array.from({ length: 100 }, (_, i) => ({
        id: `Cuota${String(i + 1).padStart(3, '0')}`,
        amount: '0.00',
        dueDate: '2026-01-01',
      }))
      return Array.from({ length: 20 }, (_, i) =>
        xml(name(i), {
          seriesNumber: `F001-${i + 1}`,
          documentType: '03',
          recipientRuc: '20100070970',
          issuerRuc: '10467286736',
          currency: 'EUR',
          issueDate: '2026-12-31',
          total: '1.00',
          netPendingAmount: '2.00',
          installments,
        }),
      )
    }
    const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))

    it('el 422 más grande que admiten los topes por defecto pesa menos de 4.5 MB', async () => {
      // Nombres del largo máximo (255 unidades) en caracteres de 3 bytes, lo que más pesa en JSON.
      const xmlFiles = worstCase((i) => `${'請'.repeat(248)}${String(i).padStart(3, '0')}.xml`)
      expect(xmlFiles.every((f) => f.originalname.length === 255)).toBe(true)
      const result = await service.evaluate(input({ xmlFiles }))
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.problems.length).toBe(1 + 20 * 207)
      for (const problem of result.problems) problemSchema.parse(problem)
      expect(jsonBytes(result.problems)).toBeLessThan(4.5 * MB)
    })

    it.each([
      ['16 000 caracteres', (i: number) => `${'x'.repeat(16_000)}${i}.xml`],
      [
        '5 400 controles, que JSON escribe con 6 bytes cada uno',
        (i: number) => `${'\u0001'.repeat(5_400)}${i}.xml`,
      ],
    ])('el mismo envío con nombres de %s responde un 422 de pocos kilobytes', async (_, name) => {
      // multer acepta un nombre de hasta unos 16 KiB (el tope de la cabecera de la parte en busboy).
      const result = await service.evaluate(input({ xmlFiles: worstCase(name) }))
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(jsonBytes(result.problems)).toBeLessThan(20 * 1024)
      expect(result.problems.map((p) => p.code)).toEqual([
        ...Array.from({ length: 20 }, () => 'INVALID_FILE_NAME'),
        'TOO_MANY_INVOICES',
      ])
    })
  })

  describe('con el lector de XML', () => {
    it('lee los XML de a uno y en el orden recibido, con sus bytes y el tope; uno mayor al tope nunca llega al lector', async () => {
      const reader = new InlineInvoiceXmlParser()
      const first = xml('F001-1.xml', { seriesNumber: 'F001-1' })
      const second = xml('F001-2.xml', { seriesNumber: 'F001-2' })
      const result = await new InvoiceIntakeService(LIMITS, reader).evaluate(
        input({ xmlFiles: [first, upload('grande.xml', Buffer.alloc(MB + 1, 0x20)), second] }),
      )
      expect(reader.calls).toHaveLength(2)
      expect(reader.calls[0]?.xml).toBe(first.buffer)
      expect(reader.calls[1]?.xml).toBe(second.buffer)
      expect(reader.calls.map((call) => call.maxLength)).toEqual([MB, MB])
      expect(reader.maxConcurrent).toBe(1)
      expect(result).toEqual({
        ok: false,
        problems: [expect.objectContaining({ code: 'XML_TOO_LARGE', file: 'grande.xml' })],
      })
    })

    it.each(['timeout', 'memory'] as const)(
      'un XML que pasa el tope del lector (%s) es UNREADABLE_XML con su nombre; los demás se leen y validan igual',
      async (reason) => {
        const reader = new InlineInvoiceXmlParser()
        reader.outcomes.set(1, { status: 'too-expensive', reason })
        const result = await new InvoiceIntakeService(LIMITS, reader).evaluate(
          input({
            xmlFiles: [
              xml('F001-1.xml', { seriesNumber: 'F001-1' }),
              xml('hostil.xml', { seriesNumber: 'F001-9' }),
              xml('F001-2.xml', { seriesNumber: 'F001-2', currency: 'EUR' }),
            ],
          }),
        )
        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.problems.map((p) => [p.code, p.file, p.invoice ?? null])).toEqual([
          ['UNREADABLE_XML', 'hostil.xml', null],
          ['CURRENCY_NOT_ALLOWED', 'F001-2.xml', 'F001-2'],
        ])
        for (const problem of result.problems) problemSchema.parse(problem)
      },
    )

    it.each(['saturated', 'start-failed', 'shutting-down'] as const)(
      'con el lector no disponible (%s) la solicitud es 503, nunca un problema del archivo',
      async (reason) => {
        const reader = new InlineInvoiceXmlParser()
        const unavailable: InvoiceXmlParseOutcome = { status: 'unavailable', reason }
        reader.outcomes.set(1, unavailable)
        const evaluation = new InvoiceIntakeService(LIMITS, reader).evaluate(
          input({
            xmlFiles: [
              xml('F001-1.xml', { seriesNumber: 'F001-1' }),
              xml('F001-2.xml', { seriesNumber: 'F001-2' }),
              xml('F001-3.xml', { seriesNumber: 'F001-3' }),
            ],
          }),
        )
        await expect(evaluation).rejects.toThrow(ServiceUnavailableError)
        await expect(evaluation).rejects.toThrow(reason)
        // No sigue leyendo: la solicitud entera se reintenta.
        expect(reader.calls).toHaveLength(2)
      },
    )

    it('con la señal cancelada rechaza con su motivo, pasa la señal al lector y no lee más XML', async () => {
      const controller = new AbortController()
      const reason = new Error('plazo del envío')
      const signals: (AbortSignal | undefined)[] = []
      const reader: InvoiceXmlParserPort = {
        parse: async (_xml, options) => {
          signals.push(options.signal)
          if (signals.length === 1) {
            controller.abort(reason)
            throw reason
          }
          return {
            status: 'parsed',
            result: { ok: false, problem: { code: 'NOT_AN_INVOICE' } },
          } as never
        },
      }
      const evaluation = new InvoiceIntakeService(LIMITS, reader).evaluate(
        input({
          xmlFiles: [
            xml('F001-1.xml', { seriesNumber: 'F001-1' }),
            xml('F001-2.xml', { seriesNumber: 'F001-2' }),
          ],
        }),
        { signal: controller.signal },
      )
      await expect(evaluation).rejects.toBe(reason)
      expect(signals).toEqual([controller.signal])

      const already = new AbortController()
      already.abort(reason)
      const counting = new InlineInvoiceXmlParser()
      await expect(
        new InvoiceIntakeService(LIMITS, counting).evaluate(input(), { signal: already.signal }),
      ).rejects.toBe(reason)
      expect(counting.calls).toHaveLength(0)
    })

    it('un defecto del lector no se disfraza de problema del proveedor', async () => {
      const reader = new InlineInvoiceXmlParser()
      reader.outcomes.set(0, new Error('defecto del lector'))
      await expect(new InvoiceIntakeService(LIMITS, reader).evaluate(input())).rejects.toThrow(
        'defecto del lector',
      )
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
    expect(() => new InvoiceIntakeService(limits, parser)).toThrow(RangeError)
  })
})
