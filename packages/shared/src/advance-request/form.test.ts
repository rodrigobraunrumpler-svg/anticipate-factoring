import { describe, expect, it } from 'vitest'
import { MESSAGES_ES, VALIDATION_MESSAGES_ES } from '../errors/index.js'
import { advanceRequestFormSchema, FORM_MESSAGES } from './form.js'

/** Todo texto de validación en español que puede devolver el formulario. */
const spanishMessages = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : Object.values(value as Record<string, unknown>).flatMap((v) => spanishMessages(v))

const valid = {
  contact: {
    fullName: 'Ana Pérez',
    dni: '46728673',
    mobile: '987654321',
    email: 'ana@proveedor.pe',
    isLegalRepresentative: true,
    contactTimeSlot: 'MORNING',
  },
  company: { ruc: '20100070970', legalName: 'PROVEEDOR EJEMPLO S.A.C.' },
  financing: { requestedAmount: '8000.00', purpose: 'Capital de trabajo' },
  cavaliRegistration: 'UNKNOWN',
  consents: { terms: true, personalData: true, termsVersion: '2026-09', privacyVersion: '2026-09' },
  source: { utm: { utm_source: 'linkedin' }, referrer: 'https://www.linkedin.com/' },
}

describe('advanceRequestFormSchema', () => {
  it('acepta un formulario completo', () => {
    expect(advanceRequestFormSchema.safeParse(valid).success).toBe(true)
  })

  it('exige cargo cuando el contacto no es representante legal', () => {
    const r = advanceRequestFormSchema.safeParse({
      ...valid,
      contact: { ...valid.contact, isLegalRepresentative: false },
    })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['contact', 'jobTitle'])
  })

  it('acepta cargo cuando no es representante', () => {
    const r = advanceRequestFormSchema.safeParse({
      ...valid,
      contact: { ...valid.contact, isLegalRepresentative: false, jobTitle: 'Contadora' },
    })
    expect(r.success).toBe(true)
  })

  it('exige ambos consentimientos en true', () => {
    const r = advanceRequestFormSchema.safeParse({
      ...valid,
      consents: { ...valid.consents, personalData: false },
    })
    expect(r.success).toBe(false)
  })

  it('valida celular peruano de 9 dígitos que empieza en 9', () => {
    for (const mobile of ['98765432', '187654321', '9876 54321']) {
      const r = advanceRequestFormSchema.safeParse({
        ...valid,
        contact: { ...valid.contact, mobile },
      })
      expect(r.success, mobile).toBe(false)
    }
  })

  it('normaliza correo a minúsculas y recorta espacios', () => {
    const r = advanceRequestFormSchema.parse({
      ...valid,
      contact: { ...valid.contact, email: '  Ana@Proveedor.PE ' },
    })
    expect(r.contact.email).toBe('ana@proveedor.pe')
  })

  it('source es opcional y sus utm se limitan a claves utm_*', () => {
    const { source: _omitted, ...withoutSource } = valid
    expect(advanceRequestFormSchema.safeParse(withoutSource).success).toBe(true)
    const r = advanceRequestFormSchema.safeParse({ ...valid, source: { utm: { password: 'x' } } })
    expect(r.success).toBe(false)
  })

  it('rechaza un correo de más de 254 caracteres con el mensaje en español', () => {
    const longEmail = `${'a'.repeat(250)}@x.co` // 255 caracteres
    const r = advanceRequestFormSchema.safeParse({
      ...valid,
      contact: { ...valid.contact, email: longEmail },
    })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0]?.message).toBe(FORM_MESSAGES.emailMax)
  })

  it('rechaza una versión de términos o de privacidad de más de 20 caracteres', () => {
    const longVersion = 'v'.repeat(21)
    const terms = advanceRequestFormSchema.safeParse({
      ...valid,
      consents: { ...valid.consents, termsVersion: longVersion },
    })
    expect(terms.success).toBe(false)
    if (!terms.success) expect(terms.error.issues[0]?.message).toBe(FORM_MESSAGES.termsVersionMax)

    const privacy = advanceRequestFormSchema.safeParse({
      ...valid,
      consents: { ...valid.consents, privacyVersion: longVersion },
    })
    expect(privacy.success).toBe(false)
    if (!privacy.success) {
      expect(privacy.error.issues[0]?.message).toBe(FORM_MESSAGES.privacyVersionMax)
    }
  })

  it('rechaza más de 10 parámetros utm', () => {
    const utm = Object.fromEntries(
      Array.from({ length: 11 }, (_, i) => [`utm_key${String.fromCharCode(97 + i)}`, 'v']),
    )
    const r = advanceRequestFormSchema.safeParse({ ...valid, source: { ...valid.source, utm } })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues.some((issue) => issue.message === FORM_MESSAGES.utmTooMany)).toBe(true)
    }
    // El tope del código coincide con el que anuncia el mensaje ("máximo 10").
    expect(FORM_MESSAGES.utmTooMany).toContain('máximo 10')
    const ten = Object.fromEntries(Object.entries(utm).slice(0, 10))
    expect(
      advanceRequestFormSchema.safeParse({ ...valid, source: { ...valid.source, utm: ten } })
        .success,
    ).toBe(true)
  })

  it('rechaza una clave utm de más de 40 caracteres', () => {
    const longKey = `utm_${'a'.repeat(37)}` // 41 caracteres
    const r = advanceRequestFormSchema.safeParse({
      ...valid,
      source: { ...valid.source, utm: { [longKey]: 'x' } },
    })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0]?.message).toBe(FORM_MESSAGES.utmKey)
  })

  it('nunca deja pasar un mensaje en inglés por defecto de Zod', () => {
    const invalid = {
      contact: {
        fullName: 'A',
        dni: '46728673',
        mobile: '123456789',
        email: `${'a'.repeat(250)}@x.co`,
        isLegalRepresentative: 'sí',
        contactTimeSlot: 'NOON',
      },
      company: { ruc: '20100070970', legalName: 'X' },
      financing: { requestedAmount: '8000.00', purpose: 'p'.repeat(501) },
      cavaliRegistration: 'MAYBE',
      consents: {
        terms: false,
        personalData: false,
        termsVersion: '',
        privacyVersion: 'v'.repeat(21),
      },
      source: { utm: { password: 'x' }, referrer: 'not-a-url' },
    }
    const r = advanceRequestFormSchema.safeParse(invalid)
    expect(r.success).toBe(false)
    if (!r.success) {
      const allowedMessages = new Set<string>([
        ...spanishMessages(VALIDATION_MESSAGES_ES),
        ...Object.values(MESSAGES_ES),
      ])
      expect(r.error.issues.length).toBeGreaterThan(1)
      for (const issue of r.error.issues) {
        expect(allowedMessages.has(issue.message), issue.message).toBe(true)
      }
    }
  })

  it('FORM_MESSAGES es el grupo del formulario de los mensajes de errors', () => {
    expect(FORM_MESSAGES).toBe(VALIDATION_MESSAGES_ES.advanceRequestForm)
  })
})
