import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildCdrXml, buildInvoiceXml } from '../../src/invoice/build-test-xml.js'

const dir = fileURLToPath(new URL('./cases/', import.meta.url))
mkdirSync(dir, { recursive: true })

const cases: Record<string, string> = {
  'seed-credit-pen.xml': buildInvoiceXml(),
  'seed-credit-usd-two-installments.xml': buildInvoiceXml({
    currency: 'USD',
    installments: [
      { id: 'Cuota001', amount: '5000.00', dueDate: '2026-10-30' },
      { id: 'Cuota002', amount: '5620.00', dueDate: '2026-11-30' },
    ],
  }),
  'seed-cash.xml': buildInvoiceXml({
    paymentTerms: 'Contado',
    netPendingAmount: null,
    installments: [],
  }),
  'seed-receipt.xml': buildInvoiceXml({ documentType: '03' }),
  'seed-other-recipient.xml': buildInvoiceXml({ recipientRuc: '20100070970' }),
  'seed-legacy-ruc-path.xml': buildInvoiceXml({ legacyRucPath: true }),
  'seed-cdr.xml': buildCdrXml(),
}

for (const [name, xml] of Object.entries(cases)) writeFileSync(dir + name, xml)
console.log(`${Object.keys(cases).length} casos escritos en ${dir}`)
