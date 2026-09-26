import { describe, expect, it } from 'vitest'
import { buildInvoiceXml } from '../testing/index.js'
import { PARSED_INVOICE_LIMITS, parsedInvoiceSchema } from './parsed-invoice.js'
import { parseUblInvoice } from './ubl-parser.js'

const parsed = (() => {
  const r = parseUblInvoice(buildInvoiceXml())
  if (!r.ok) throw new Error(r.problem.code)
  return r.invoice
})()

describe('parsedInvoiceSchema · texto libre', () => {
  it.each(['issuerName', 'recipientName'] as const)(
    '%s acepta tildes, tabulación y caracteres fuera del plano básico',
    (field) => {
      const name = 'CASTAÑEDA\tE HIJOS 😀'
      expect(parsedInvoiceSchema.parse({ ...parsed, [field]: name })[field]).toBe(name)
    },
  )

  /*
   * Gemela del tipo `text` de PostgreSQL, que no guarda U+0000: una factura que cumple el esquema
   * nunca hace fallar el INSERT por un carácter de su razón social. Un sustituto suelto se guardaría
   * cambiado por U+FFFD, en silencio. Se exige lo mismo que XML 1.0, de donde viene el dato.
   */
  it.each([
    ['issuerName', 'U+0000', 'PROV\u0000EEDOR'],
    ['recipientName', 'U+0000', 'PAGA\u0000DOR'],
    ['issuerName', 'un sustituto suelto', 'PROV\uD800EEDOR'],
    ['recipientName', 'un control C0', 'PAGA\u0001DOR'],
    ['issuerName', 'U+FFFF', 'PROV\uFFFFEEDOR'],
  ] as const)('%s rechaza %s', (field, _, name) => {
    const r = parsedInvoiceSchema.safeParse({ ...parsed, [field]: name })
    expect(r.success).toBe(false)
    expect(r.error?.issues[0]?.path).toEqual([field])
  })

  it('el receptor sin nombre sigue siendo null', () => {
    expect(parsedInvoiceSchema.parse({ ...parsed, recipientName: null }).recipientName).toBeNull()
  })

  it('el tope de largo se mantiene', () => {
    const long = 'A'.repeat(PARSED_INVOICE_LIMITS.maxNameLength + 1)
    expect(parsedInvoiceSchema.safeParse({ ...parsed, issuerName: long }).success).toBe(false)
  })
})
