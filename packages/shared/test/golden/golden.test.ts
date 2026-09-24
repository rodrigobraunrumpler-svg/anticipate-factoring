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

/**
 * Elementos que en un XML real de SUNAT pueden llevar datos de una persona natural: el certificado
 * X.509 del firmante puede traer su nombre y su DNI, protegidos por la Ley 29733. El historial de
 * git es permanente, así que ningún caso real (todo lo que no empieza con `seed-`) los conserva; ver
 * el paso 3 de `README.md`.
 */
const SENSITIVE_ELEMENTS = ['SignatureValue', 'DigestValue', 'X509Certificate'] as const

type SignatureProblem = {
  file: string
  element: (typeof SENSITIVE_ELEMENTS)[number]
  content: string
}

/** Contenido de texto de cada elemento `name`, con cualquier prefijo de espacio de nombres (o ninguno). */
function elementContents(xml: string, name: string): string[] {
  const pattern = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'g')
  return [...xml.matchAll(pattern)].map((m) => (m[1] as string).trim())
}

function signatureProblems(file: string, xml: string): SignatureProblem[] {
  const problems: SignatureProblem[] = []
  for (const element of SENSITIVE_ELEMENTS) {
    for (const content of elementContents(xml, element)) {
      if (content !== 'ANONIMIZADO') problems.push({ file, element, content })
    }
  }
  return problems
}

describe('anonimización de la firma digital', () => {
  it('todo caso real reemplaza SignatureValue, DigestValue y X509Certificate por ANONIMIZADO', () => {
    const realFiles = files.filter((f) => !f.startsWith('seed-'))
    const bad = realFiles.flatMap((file) =>
      signatureProblems(file, readFileSync(casesDir + file, 'utf8')),
    )
    expect(bad, JSON.stringify(bad, null, 2)).toEqual([])
  })
})
