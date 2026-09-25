import { describe, expect, it } from 'vitest'
import { Prisma } from '#/infrastructure/prisma/generated/client.js'
import { PAYER_ROW_SELECT, type PayerRow, toPayer } from './payer-row.mapper.js'

const row = (overrides: Partial<PayerRow> = {}): PayerRow => ({
  id: '01890a5d-ac96-774b-bcce-b302099a8057',
  slug: 'sea',
  ruc: '20131312955',
  legalName: 'Servicios Energéticos Ambientales S.A.',
  shortName: 'SEA',
  advancePercent: new Prisma.Decimal('80'),
  minTermDays: 15,
  maxInvoices: 10,
  allowedCurrencies: ['PEN', 'USD'],
  accentColor: '#0E7C86',
  logoUrl: null,
  texts: { title: 'Adelanta tus facturas a SEA' },
  ...overrides,
})

describe('PAYER_ROW_SELECT', () => {
  it('pide solo las columnas de Payer: nunca active ni las fechas', () => {
    expect(Object.keys(PAYER_ROW_SELECT).sort()).toEqual([
      'accentColor',
      'advancePercent',
      'allowedCurrencies',
      'id',
      'legalName',
      'logoUrl',
      'maxInvoices',
      'minTermDays',
      'ruc',
      'shortName',
      'slug',
      'texts',
    ])
  })
})

describe('toPayer', () => {
  it('convierte la fila en Payer con el porcentaje como número de dos decimales', () => {
    const source = row({ advancePercent: new Prisma.Decimal('33.33') })
    const result = toPayer(source)
    expect(result).toEqual({
      ok: true,
      payer: {
        id: '01890a5d-ac96-774b-bcce-b302099a8057',
        slug: 'sea',
        ruc: '20131312955',
        legalName: 'Servicios Energéticos Ambientales S.A.',
        shortName: 'SEA',
        advancePercent: 33.33,
        minTermDays: 15,
        maxInvoices: 10,
        allowedCurrencies: ['PEN', 'USD'],
        accentColor: '#0E7C86',
        logoUrl: null,
        texts: { title: 'Adelanta tus facturas a SEA' },
      },
    })
    expect(result.ok && result.payer.allowedCurrencies).not.toBe(source.allowedCurrencies)
  })

  it.each<[string, Prisma.JsonValue]>([
    ['un texto', 'hola'],
    ['un arreglo', ['hola']],
    ['null', null],
  ])('no puede leer una fila con texts como %s', (_name, texts) => {
    expect(toPayer(row({ texts }))).toEqual({ ok: false, reason: 'texts no es un objeto JSON' })
  })

  it('no puede leer una fila con un texto que no es cadena', () => {
    expect(toPayer(row({ texts: { title: 'Hola', subtitle: 5 } }))).toEqual({
      ok: false,
      reason: 'el texto «subtitle» no es una cadena',
    })
  })

  it('una clave «__proto__» en el JSON queda como dato y no cambia el prototipo', () => {
    const result = toPayer(row({ texts: JSON.parse('{"__proto__":"x","title":"Hola"}') }))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(Object.getPrototypeOf(result.payer.texts)).toBe(Object.prototype)
      expect(Object.keys(result.payer.texts)).toEqual(['__proto__', 'title'])
    }
  })
})
