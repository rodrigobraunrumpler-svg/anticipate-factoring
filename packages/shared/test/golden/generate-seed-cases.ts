import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildCdrXml, buildInvoiceXml } from '../../src/testing/index.js'

const dir = fileURLToPath(new URL('./cases/', import.meta.url))
mkdirSync(dir, { recursive: true })

/** Un caso y la codificación de sus bytes en disco. `latin1` escribe ISO-8859-1 real, no UTF-8. */
type SeedCase = { xml: string; encoding: 'utf8' | 'latin1' }
const utf8 = (xml: string): SeedCase => ({ xml, encoding: 'utf8' })

const cases: Record<string, SeedCase> = {
  'seed-credit-pen.xml': utf8(buildInvoiceXml()),
  'seed-credit-usd-two-installments.xml': utf8(
    buildInvoiceXml({
      currency: 'USD',
      installments: [
        { id: 'Cuota001', amount: '5000.00', dueDate: '2026-10-30' },
        { id: 'Cuota002', amount: '5620.00', dueDate: '2026-11-30' },
      ],
    }),
  ),
  'seed-cash.xml': utf8(
    buildInvoiceXml({ paymentTerms: 'Contado', netPendingAmount: null, installments: [] }),
  ),
  'seed-receipt.xml': utf8(buildInvoiceXml({ documentType: '03' })),
  'seed-other-recipient.xml': utf8(buildInvoiceXml({ recipientRuc: '20100070970' })),
  'seed-legacy-ruc-path.xml': utf8(buildInvoiceXml({ legacyRucPath: true })),
  'seed-cdr.xml': utf8(buildCdrXml()),
  // Lo que más se parece a un XML real de SUNAT sin serlo: dos UBLExtension con la firma en la
  // segunda, cac:Signature de primer nivel, razón social en CDATA con "Ñ" y "&", finales CRLF,
  // bytes ISO-8859-1 y detracción al 12 % (neto = 11800.00 - 1416.00 = 10384.00).
  'seed-sunat-realistic.xml': {
    xml: buildInvoiceXml({
      seriesNumber: 'F002-00004567',
      issuerName: 'CONSTRUCTORA PEÑA & ASOCIADOS S.A.C.',
      cdataNames: true,
      extensionBeforeSignature: true,
      signatoryReference: true,
      windowsLineEndings: true,
      declaredEncoding: 'ISO-8859-1',
      total: '11800.00',
      detraction: { percent: '12.00', amount: '1416.00' },
      netPendingAmount: '10384.00',
      installments: [{ id: 'Cuota001', amount: '10384.00', dueDate: '2026-11-30' }],
    }),
    encoding: 'latin1',
  },
}

for (const [name, { xml, encoding }] of Object.entries(cases)) {
  if (encoding === 'latin1' && [...xml].some((ch) => (ch.codePointAt(0) ?? 0) > 0xff)) {
    throw new Error(`${name} tiene caracteres que no caben en ISO-8859-1`)
  }
  writeFileSync(dir + name, xml, encoding)
}
console.log(`${Object.keys(cases).length} casos escritos en ${dir}`)
