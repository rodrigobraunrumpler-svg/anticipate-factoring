import { describe, expect, it } from 'vitest'
import { MESSAGES_ES, VALIDATION_MESSAGES_ES } from '../errors/index.js'
import { isHexColor, publicPayerSchema } from './schema.js'

type StandardIssue = { message: string; issues?: readonly StandardIssue[] }

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

  it('los textos tienen tope de cantidad, formato de clave camelCase y longitud de valor', () => {
    const knownMessages = new Set([
      'Hay demasiados textos (máximo 30).',
      'La clave del texto debe ser camelCase (iniciar en minúscula) y tener como máximo 40 caracteres.',
      'El texto no debe superar los 2000 caracteres.',
    ])
    const collectMessages = (issues: readonly StandardIssue[]): string[] =>
      issues.flatMap((issue) => [issue.message, ...collectMessages(issue.issues ?? [])])

    const tooManyKeys = Object.fromEntries(
      Array.from({ length: 31 }, (_, i) => [`key${i}`, 'valor']),
    )
    const tooMany = publicPayerSchema.safeParse({ ...sea, texts: tooManyKeys })
    expect(tooMany.success).toBe(false)
    if (!tooMany.success) {
      const messages = collectMessages(tooMany.error.issues)
      expect(messages).toContain('Hay demasiados textos (máximo 30).')
      expect(messages.every((m) => knownMessages.has(m))).toBe(true)
    }
    expect(
      publicPayerSchema.safeParse({
        ...sea,
        texts: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`key${i}`, 'valor'])),
      }).success,
    ).toBe(true)

    const badKey = publicPayerSchema.safeParse({ ...sea, texts: { Title: 'hola' } })
    expect(badKey.success).toBe(false)
    if (!badKey.success) {
      const messages = collectMessages(badKey.error.issues)
      expect(messages).toContain(
        'La clave del texto debe ser camelCase (iniciar en minúscula) y tener como máximo 40 caracteres.',
      )
      expect(messages.every((m) => knownMessages.has(m))).toBe(true)
    }

    const longKey = publicPayerSchema.safeParse({
      ...sea,
      texts: { [`a${'b'.repeat(40)}`]: 'hola' },
    })
    expect(longKey.success).toBe(false)
    if (!longKey.success) {
      const messages = collectMessages(longKey.error.issues)
      expect(messages.every((m) => knownMessages.has(m))).toBe(true)
    }

    const longValue = publicPayerSchema.safeParse({ ...sea, texts: { title: 'x'.repeat(2001) } })
    expect(longValue.success).toBe(false)
    if (!longValue.success) {
      const messages = collectMessages(longValue.error.issues)
      expect(messages).toContain('El texto no debe superar los 2000 caracteres.')
      expect(messages.every((m) => knownMessages.has(m))).toBe(true)
    }

    expect(publicPayerSchema.safeParse(sea).success).toBe(true)
  })

  it('cada restricción responde con un mensaje en español, nunca con el inglés de Zod', () => {
    const allowed = new Set<string>([
      ...Object.values(VALIDATION_MESSAGES_ES.payer),
      MESSAGES_ES.INVALID_RUC,
    ])
    const collectMessages = (issues: readonly StandardIssue[]): string[] =>
      issues.flatMap((issue) => [issue.message, ...collectMessages(issue.issues ?? [])])
    const variants: Array<[string, Record<string, unknown>]> = [
      ['slug largo', { slug: 'a'.repeat(61) }],
      ['slug no texto', { slug: 7 }],
      ['razón social corta', { legalName: 'ab' }],
      ['razón social larga', { legalName: 'a'.repeat(201) }],
      ['nombre corto corto', { shortName: 'a' }],
      ['nombre corto largo', { shortName: 'a'.repeat(41) }],
      ['porcentaje cero', { advancePercent: 0 }],
      ['porcentaje mayor a 100', { advancePercent: 101 }],
      ['porcentaje con tres decimales', { advancePercent: 33.333 }],
      ['porcentaje como texto', { advancePercent: '80' }],
      ['plazo negativo', { minTermDays: -1 }],
      ['plazo no entero', { minTermDays: 1.5 }],
      ['máximo de facturas cero', { maxInvoices: 0 }],
      ['máximo de facturas no entero', { maxInvoices: 1.5 }],
      ['sin monedas', { allowedCurrencies: [] }],
      ['moneda desconocida', { allowedCurrencies: ['EUR'] }],
      ['color no hexadecimal', { accentColor: 'azul' }],
      ['logo que no es URL', { logoUrl: 'no-es-url' }],
      ['textos que no son objeto', { texts: 'hola' }],
    ]
    for (const [name, patch] of variants) {
      const r = publicPayerSchema.safeParse({ ...sea, ...patch })
      expect(r.success, name).toBe(false)
      if (!r.success) {
        for (const message of collectMessages(r.error.issues)) {
          expect(allowed.has(message), `${name}: ${message}`).toBe(true)
        }
      }
    }
  })

  it('el logo solo acepta URL http o https', () => {
    for (const logoUrl of [
      'javascript:alert(1)',
      'data:text/html,x',
      'ftp://cdn.ejemplo.pe/a.svg',
    ]) {
      const r = publicPayerSchema.safeParse({ ...sea, logoUrl })
      expect(r.success, logoUrl).toBe(false)
      if (!r.success) expect(r.error.issues[0]?.message).toBe(VALIDATION_MESSAGES_ES.payer.logoUrl)
    }
    expect(
      publicPayerSchema.safeParse({ ...sea, logoUrl: 'https://cdn.ejemplo.pe/sea.svg' }).success,
    ).toBe(true)
  })
})
