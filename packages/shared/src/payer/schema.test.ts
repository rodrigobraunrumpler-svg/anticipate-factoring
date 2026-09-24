import { describe, expect, it } from 'vitest'
import { isHexColor, publicPayerSchema } from './schema.js'

const sea = {
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
  texts: {
    title: 'Adelanta tus facturas a SEA',
    subtitle: 'Cobra hoy lo que SEA te pagará en 60 días',
  },
}

describe('publicPayerSchema', () => {
  it('acepta un pagador completo', () => {
    expect(publicPayerSchema.safeParse(sea).success).toBe(true)
  })

  it('el slug es kebab-case en minúsculas', () => {
    for (const slug of ['SEA', 'sea 2', 'sea_2', '-sea']) {
      expect(publicPayerSchema.safeParse({ ...sea, slug }).success, slug).toBe(false)
    }
    expect(publicPayerSchema.safeParse({ ...sea, slug: 'sea-2' }).success).toBe(true)
  })

  it('el porcentaje está entre 1 y 100 con hasta dos decimales', () => {
    expect(publicPayerSchema.safeParse({ ...sea, advancePercent: 0 }).success).toBe(false)
    expect(publicPayerSchema.safeParse({ ...sea, advancePercent: 100.5 }).success).toBe(false)
    expect(publicPayerSchema.safeParse({ ...sea, advancePercent: 33.333 }).success).toBe(false)
    expect(publicPayerSchema.safeParse({ ...sea, advancePercent: 33.33 }).success).toBe(true)
  })

  it('logo opcional y color hexadecimal', () => {
    expect(publicPayerSchema.safeParse({ ...sea, logoUrl: null }).success).toBe(true)
    expect(publicPayerSchema.safeParse({ ...sea, accentColor: 'azul' }).success).toBe(false)
    expect(isHexColor('#abc')).toBe(true)
    expect(isHexColor('#0E7C86')).toBe(true)
    expect(isHexColor('0E7C86')).toBe(false)
  })
})
