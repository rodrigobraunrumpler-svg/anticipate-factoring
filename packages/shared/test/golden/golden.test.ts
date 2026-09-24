import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type ValidationContext, validateInvoices } from '../../src/invoice/rules.js'
import { parseUblInvoice } from '../../src/invoice/ubl-parser.js'

const casesDir = fileURLToPath(new URL('./cases/', import.meta.url))

/** Contexto fijo para que los snapshots sean reproducibles. Sin `supplierRuc`: los casos reales vienen de emisores distintos. */
const ctx: ValidationContext = {
  payerRuc: '20131312955',
  payerName: 'SEA',
  advancePercent: 80,
  minTermDays: 15,
  maxInvoices: 10,
  allowedCurrencies: ['PEN', 'USD'],
  today: '2026-09-23',
}

const files = readdirSync(casesDir)
  .filter((f) => f.endsWith('.xml'))
  .sort()

describe('suite dorada', () => {
  it('hay al menos un caso', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it.each(files)('%s produce el resultado esperado', async (file) => {
    const parsed = parseUblInvoice(readFileSync(casesDir + file, 'utf8'))
    const result = parsed.ok
      ? { parsed: parsed.invoice, validation: validateInvoices([parsed.invoice], ctx) }
      : { parsed: parsed.problem }
    // El "\n" final es porque `pnpm lint:fix` le exige salto de línea a todo archivo JSON: sin él,
    // formatear el snapshot con Biome lo deja distinto de lo que este test vuelve a generar.
    await expect(`${JSON.stringify(result, null, 2)}\n`).toMatchFileSnapshot(
      `./expected/${file.replace(/\.xml$/, '.json')}`,
    )
  })
})
