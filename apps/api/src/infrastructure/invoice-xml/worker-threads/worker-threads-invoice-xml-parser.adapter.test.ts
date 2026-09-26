import { decodeXml, parseUblInvoice } from '@anticipate/shared/invoice'
import { buildCdrXml, buildInvoiceXml } from '@anticipate/shared/testing'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { hostileInvoiceXml } from '../../../../test/support/hostile-xml.js'
import {
  bytesForWorker,
  type InvoiceXmlParserOptions,
  WorkerThreadsInvoiceXmlParser,
} from './worker-threads-invoice-xml-parser.adapter.js'

const MB = 1024 * 1024

const utf8 = (text: string): Buffer => Buffer.from(text, 'utf8')

const parsers: WorkerThreadsInvoiceXmlParser[] = []

const options = (overrides: Partial<InvoiceXmlParserOptions> = {}): InvoiceXmlParserOptions => ({
  workers: 2,
  queueLimit: 8,
  queueTimeoutMs: 30_000,
  timeoutMs: 30_000,
  workerHeapMb: 128,
  ...overrides,
})

/** Un lector para un solo test: `afterEach` lo cierra. */
function createParser(overrides: Partial<InvoiceXmlParserOptions> = {}) {
  const parser = new WorkerThreadsInvoiceXmlParser(options(overrides))
  parsers.push(parser)
  return parser
}

afterEach(async () => {
  await Promise.all(parsers.splice(0).map((parser) => parser.close()))
})

describe('WorkerThreadsInvoiceXmlParser', () => {
  describe('lee en un worker exactamente lo que el lector de shared lee en el hilo principal', () => {
    // Un solo lector para todos los casos: sus hilos atienden un XML tras otro, como en producción.
    const shared = new WorkerThreadsInvoiceXmlParser(options())
    afterAll(() => shared.close())

    const cases: readonly [name: string, xml: Buffer, maxLength?: number][] = [
      ['una factura válida', utf8(buildInvoiceXml())],
      ['con BOM', utf8(buildInvoiceXml({ bom: true }))],
      ['con fin de línea de Windows', utf8(buildInvoiceXml({ windowsLineEndings: true }))],
      [
        'declarado y escrito en windows-1252',
        Buffer.from(
          buildInvoiceXml({ declaredEncoding: 'windows-1252', issuerName: 'CAÑA & AÑIL S.A.C.' }),
          'latin1',
        ),
      ],
      [
        'declarado UTF-8 pero escrito en windows-1252',
        Buffer.from(buildInvoiceXml({ issuerName: 'CAÑA S.A.C.' }), 'latin1'),
      ],
      ['con las razones sociales en CDATA', utf8(buildInvoiceXml({ cdataNames: true }))],
      ['con el RUC por la ruta legada', utf8(buildInvoiceXml({ legacyRucPath: true }))],
      ['sin fecha de emisión', utf8(buildInvoiceXml({ omit: ['IssueDate'] }))],
      ['con U+0000 en un dato', utf8(buildInvoiceXml({ issuerName: 'PROV\u0000EEDOR' }))],
      ['con emisión en el año 0000', utf8(buildInvoiceXml({ issueDate: '0000-01-01' }))],
      ['que no es XML', utf8('%PDF-1.7 no soy xml')],
      ['vacío', Buffer.alloc(0)],
      [
        'con DOCTYPE',
        utf8(buildInvoiceXml().replace('<Invoice', '<!DOCTYPE Invoice [<!ENTITY x "y">]><Invoice')),
      ],
      ['una constancia de recepción (CDR)', utf8(buildCdrXml())],
      ['más largo que maxLength', utf8(buildInvoiceXml()), 100],
      ['hostil de 1 MiB', hostileInvoiceXml()],
    ]

    it.each(cases)('%s', async (_, xml, maxLength = MB) => {
      const expected = parseUblInvoice(decodeXml(xml), { maxLength })
      await expect(shared.parse(xml, { maxLength })).resolves.toEqual({
        status: 'parsed',
        result: expected,
      })
    })
  })

  it('no modifica ni se queda con el buffer de quien llama; de una vista lee solo sus bytes', async () => {
    const parser = createParser()
    const xml = utf8(buildInvoiceXml({ seriesNumber: 'F001-77' }))
    // La vista vive en medio de un buffer mayor, rodeada de bytes que no son XML.
    const backing = Buffer.alloc(3 * xml.length + 5_000, 0xff)
    xml.copy(backing, 5_000)
    const view = backing.subarray(5_000, 5_000 + xml.length)
    const before = Buffer.from(backing)
    const outcome = await parser.parse(view, { maxLength: MB })
    expect(outcome).toEqual({
      status: 'parsed',
      result: parseUblInvoice(decodeXml(xml), { maxLength: MB }),
    })
    expect(view.byteLength).toBe(xml.length)
    expect(backing.equals(before)).toBe(true)
  })

  it('al worker viaja el buffer si es entero; si es una vista, una copia exacta de sus bytes', () => {
    // `Buffer.alloc` nunca usa el bloque compartido: el buffer es dueño de su ArrayBuffer entero.
    const whole = Buffer.alloc(5_000, 0x20)
    expect(whole.buffer.byteLength).toBe(whole.byteLength)
    expect(bytesForWorker(whole)).toBe(whole)
    // `postMessage` copiaría el ArrayBuffer entero detrás de la vista: aquí, 3 MiB por 2 KiB.
    const backing = new Uint8Array(3 * MB)
    const view = backing.subarray(1_000, 3_000)
    view.fill(0x41)
    const sent = bytesForWorker(view)
    expect(sent).not.toBe(view)
    expect(sent.byteOffset).toBe(0)
    expect(sent.buffer.byteLength).toBe(2_000)
    expect(Buffer.from(sent).equals(Buffer.from(view))).toBe(true)
    // Un Buffer chico (como los de multer) vive en el bloque compartido de Node (`Buffer.poolSize`).
    const pooled = Buffer.from('<a/>')
    expect(pooled.buffer.byteLength).toBeGreaterThan(pooled.byteLength)
    expect(bytesForWorker(pooled).buffer.byteLength).toBe(pooled.byteLength)
  })

  it('un XML que pasa el plazo es too-expensive: su hilo se termina y el lector sigue atendiendo', async () => {
    // Márgenes en los dos sentidos, aun con la máquina saturada: el XML hostil de 3 MiB tarda 1,5 s o
    // más (tres veces el plazo) y la factura de prueba, milisegundos. Heap holgado: aquí se prueba el
    // plazo, no la memoria.
    const parser = createParser({ workers: 1, timeoutMs: 500, workerHeapMb: 1024 })
    await parser.start()
    await expect(parser.parse(hostileInvoiceXml(3 * MB), { maxLength: 4 * MB })).resolves.toEqual({
      status: 'too-expensive',
      reason: 'timeout',
    })
    await expect(parser.parse(utf8(buildInvoiceXml()), { maxLength: MB })).resolves.toEqual(
      expect.objectContaining({ status: 'parsed', result: expect.objectContaining({ ok: true }) }),
    )
  })

  it('un XML que pasa el tope de memoria es too-expensive y el lector sigue atendiendo', async () => {
    const parser = createParser({ workers: 1, workerHeapMb: 32 })
    await parser.start()
    await expect(parser.parse(hostileInvoiceXml(), { maxLength: MB })).resolves.toEqual({
      status: 'too-expensive',
      reason: 'memory',
    })
    await expect(parser.parse(utf8(buildInvoiceXml()), { maxLength: MB })).resolves.toEqual(
      expect.objectContaining({ status: 'parsed', result: expect.objectContaining({ ok: true }) }),
    )
  })

  it('con la cola llena responde unavailable saturated en el acto', async () => {
    const parser = createParser({ workers: 1, queueLimit: 1 })
    await parser.start()
    const running = parser.parse(hostileInvoiceXml(), { maxLength: MB })
    const queued = parser.parse(utf8(buildInvoiceXml()), { maxLength: MB })
    await expect(parser.parse(utf8(buildInvoiceXml()), { maxLength: MB })).resolves.toEqual({
      status: 'unavailable',
      reason: 'saturated',
    })
    await expect(running).resolves.toEqual(expect.objectContaining({ status: 'parsed' }))
    await expect(queued).resolves.toEqual(expect.objectContaining({ status: 'parsed' }))
  })

  it('un XML que espera un hilo más que queueTimeoutMs responde unavailable saturated', async () => {
    const parser = createParser({ workers: 1, queueTimeoutMs: 50 })
    await parser.start()
    const running = parser.parse(hostileInvoiceXml(), { maxLength: MB })
    await expect(parser.parse(utf8(buildInvoiceXml()), { maxLength: MB })).resolves.toEqual({
      status: 'unavailable',
      reason: 'saturated',
    })
    await expect(running).resolves.toEqual(expect.objectContaining({ status: 'parsed' }))
  })

  it('con la señal cancelada rechaza con su motivo: en la cola, sale de la cola', async () => {
    const parser = createParser({ workers: 1 })
    await parser.start()
    const hostile = parser.parse(hostileInvoiceXml(MB), { maxLength: MB })
    const controller = new AbortController()
    const waiting = parser.parse(utf8(buildInvoiceXml()), {
      maxLength: MB,
      signal: controller.signal,
    })
    expect(parser.stats.queued).toBe(1)
    const reason = new Error('plazo del envío')
    controller.abort(reason)
    await expect(waiting).rejects.toBe(reason)
    expect(parser.stats.queued).toBe(0)
    await hostile

    const already = new AbortController()
    already.abort(reason)
    await expect(
      parser.parse(utf8(buildInvoiceXml()), { maxLength: MB, signal: already.signal }),
    ).rejects.toBe(reason)
  })

  it('arranca un hilo con onModuleInit y los termina todos con onApplicationShutdown', async () => {
    const parser = createParser()
    await parser.onModuleInit()
    expect(parser.stats).toEqual(expect.objectContaining({ workers: 1, idle: 1 }))
    const pending = parser.parse(hostileInvoiceXml(), { maxLength: MB })
    await parser.onApplicationShutdown()
    await expect(pending).resolves.toEqual({ status: 'unavailable', reason: 'shutting-down' })
    expect(parser.stats.workers).toBe(0)
    await expect(parser.parse(utf8(buildInvoiceXml()), { maxLength: MB })).resolves.toEqual({
      status: 'unavailable',
      reason: 'shutting-down',
    })
  })
})
