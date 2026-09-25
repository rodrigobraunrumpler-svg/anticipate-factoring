import { VALIDATION_MESSAGES_ES } from '@anticipate/shared/errors'
import { describe, expect, it } from 'vitest'
import type { Payer } from '#/modules/payers/domain/types/payer.js'
import { toPublicPayer, toPublicPayers } from './public-payer.mapper.js'

const sea: Payer = {
  id: '01890a5d-ac96-774b-bcce-b302099a8057',
  slug: 'sea',
  ruc: '20131312955',
  legalName: 'Servicios Energéticos Ambientales S.A.',
  shortName: 'SEA',
  advancePercent: 80,
  minTermDays: 15,
  maxInvoices: 10,
  allowedCurrencies: ['PEN', 'USD'],
  accentColor: '#0E7C86',
  logoUrl: 'https://cdn.ejemplo.pe/sea.svg',
  texts: { title: 'Adelanta tus facturas a SEA' },
}

const agro: Payer = {
  ...sea,
  id: '01890a5d-ac96-774b-bcce-b302099a8058',
  slug: 'agro-andina',
  ruc: '20100070970',
  legalName: 'Agro Andina S.A.C.',
  shortName: 'Agro Andina',
  logoUrl: null,
}

describe('toPublicPayer', () => {
  it('copia solo los campos públicos y deja fuera el id interno', () => {
    const result = toPublicPayer(sea)
    expect(result).toEqual({
      ok: true,
      payer: {
        slug: 'sea',
        ruc: '20131312955',
        legalName: 'Servicios Energéticos Ambientales S.A.',
        shortName: 'SEA',
        advancePercent: 80,
        minTermDays: 15,
        maxInvoices: 10,
        allowedCurrencies: ['PEN', 'USD'],
        accentColor: '#0E7C86',
        logoUrl: 'https://cdn.ejemplo.pe/sea.svg',
        texts: { title: 'Adelanta tus facturas a SEA' },
      },
    })
    expect(result.ok && result.payer).not.toHaveProperty('id')
  })

  it('rechaza con su id, su slug y el motivo en español un pagador fuera del contrato', () => {
    const result = toPublicPayer({ ...sea, advancePercent: 0.5 })
    expect(result).toEqual({
      ok: false,
      rejected: {
        id: sea.id,
        slug: 'sea',
        issues: [`advancePercent: ${VALIDATION_MESSAGES_ES.payer.advancePercent}`],
      },
    })
  })

  it.each<[string, Partial<Payer>, keyof Payer]>([
    ['un logo que no es http ni https', { logoUrl: 'javascript:alert(1)' }, 'logoUrl'],
    ['una clave de texto que no es camelCase', { texts: { Title: 'hola' } }, 'texts'],
    ['un color que no es hexadecimal', { accentColor: 'azul' }, 'accentColor'],
    ['un RUC con dígito verificador inválido', { ruc: '20131312956' }, 'ruc'],
    ['sin monedas', { allowedCurrencies: [] }, 'allowedCurrencies'],
  ])('rechaza %s', (_name, patch, field) => {
    const result = toPublicPayer({ ...sea, ...patch })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.rejected.issues.some((issue) => issue.startsWith(`${field}`))).toBe(true)
    }
  })
})

describe('toPublicPayers', () => {
  it('omite los que no cumplen el contrato sin perder a los demás ni cambiar el orden', () => {
    const broken = {
      ...sea,
      id: '01890a5d-ac96-774b-bcce-b302099a8059',
      slug: 'rota',
      maxInvoices: 0,
    }
    const { payers, rejected } = toPublicPayers([agro, broken, sea])
    expect(payers.map((payer) => payer.slug)).toEqual(['agro-andina', 'sea'])
    expect(rejected).toEqual([
      {
        id: broken.id,
        slug: 'rota',
        issues: [`maxInvoices: ${VALIDATION_MESSAGES_ES.payer.maxInvoices}`],
      },
    ])
  })

  it('sin pagadores devuelve dos listas vacías', () => {
    expect(toPublicPayers([])).toEqual({ payers: [], rejected: [] })
  })
})
