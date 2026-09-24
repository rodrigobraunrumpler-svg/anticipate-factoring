import { describe, expect, it } from 'vitest'
import { advanceRequestFormSchema } from './form.js'

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
})
