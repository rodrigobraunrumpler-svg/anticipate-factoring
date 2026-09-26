import {
  type AdvanceRequestForm,
  advanceRequestFormSchema,
} from '@anticipate/shared/advance-request'
import { describe, expect, it } from 'vitest'
import {
  canonicalJson,
  computeRequestFingerprint,
  type FingerprintFile,
  sha256Hex,
} from './request-fingerprint.js'

const form = (overrides: Record<string, unknown> = {}): AdvanceRequestForm =>
  advanceRequestFormSchema.parse({
    payerSlug: 'sea',
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
    consents: {
      terms: true,
      personalData: true,
      termsVersion: '2026-09',
      privacyVersion: '2026-09',
    },
    source: { utm: { utm_source: 'linkedin', utm_medium: 'social' } },
    ...overrides,
  })

const xml: FingerprintFile = {
  field: 'xml',
  originalname: 'F001-123.xml',
  sha256: sha256Hex('xml'),
}
const pdf: FingerprintFile = {
  field: 'pdf',
  originalname: 'F001-123.pdf',
  sha256: sha256Hex('pdf'),
}

describe('sha256Hex', () => {
  it('es el sha256 estándar en hexadecimal minúsculo', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(sha256Hex(Buffer.from('abc'))).toBe(sha256Hex('abc'))
  })
})

describe('canonicalJson', () => {
  it('ordena las claves en todos los niveles y conserva el orden de las listas', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[3,1]},"b":1}',
    )
  })

  it('omite las propiedades undefined como JSON.stringify', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }))
    expect(canonicalJson([undefined, null])).toBe('[null,null]')
  })

  it.each([
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [new Date('2026-09-24T00:00:00Z')],
    [new Map()],
    [10n],
    [() => 1],
    [undefined],
  ])('rechaza lo que no es JSON (%s)', (value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError)
  })
})

describe('computeRequestFingerprint', () => {
  it('es sha256 hexadecimal, el formato del CHECK de request_fingerprint', () => {
    expect(computeRequestFingerprint(form(), [xml, pdf])).toMatch(/^[0-9a-f]{64}$/)
  })

  it('no cambia con el orden de las claves del formulario ni el de los archivos', () => {
    const reordered = advanceRequestFormSchema.parse({
      source: { utm: { utm_medium: 'social', utm_source: 'linkedin' } },
      consents: {
        privacyVersion: '2026-09',
        termsVersion: '2026-09',
        personalData: true,
        terms: true,
      },
      cavaliRegistration: 'UNKNOWN',
      financing: { purpose: 'Capital de trabajo', requestedAmount: '8000.00' },
      company: { legalName: 'PROVEEDOR EJEMPLO S.A.C.', ruc: '20100070970' },
      contact: {
        contactTimeSlot: 'MORNING',
        isLegalRepresentative: true,
        email: 'ana@proveedor.pe',
        mobile: '987654321',
        dni: '46728673',
        fullName: 'Ana Pérez',
      },
      payerSlug: 'sea',
    })
    expect(computeRequestFingerprint(reordered, [pdf, xml])).toBe(
      computeRequestFingerprint(form(), [xml, pdf]),
    )
  })

  it('usa el formulario normalizado: espacios, mayúsculas del correo y ceros del monto no cuentan', () => {
    const messy = form({
      contact: {
        fullName: '  Ana Pérez ',
        dni: '46728673',
        mobile: '987654321',
        email: ' ANA@Proveedor.pe ',
        isLegalRepresentative: true,
        contactTimeSlot: 'MORNING',
      },
      financing: { requestedAmount: '008000.00', purpose: 'Capital de trabajo' },
    })
    expect(computeRequestFingerprint(messy, [xml])).toBe(computeRequestFingerprint(form(), [xml]))
  })

  it('cambia si cambia un dato del formulario', () => {
    const base = computeRequestFingerprint(form(), [xml])
    expect(
      computeRequestFingerprint(form({ financing: { requestedAmount: '8000.01' } }), [xml]),
    ).not.toBe(base)
    expect(computeRequestFingerprint(form({ cavaliRegistration: 'YES' }), [xml])).not.toBe(base)
  })

  it('cambia si cambia el contenido, el nombre o el campo de un archivo', () => {
    const base = computeRequestFingerprint(form(), [xml, pdf])
    expect(
      computeRequestFingerprint(form(), [xml, { ...pdf, sha256: sha256Hex('otro pdf') }]),
    ).not.toBe(base)
    expect(
      computeRequestFingerprint(form(), [xml, { ...pdf, originalname: 'F001-124.pdf' }]),
    ).not.toBe(base)
    expect(computeRequestFingerprint(form(), [xml, { ...pdf, field: 'xml' }])).not.toBe(base)
    expect(computeRequestFingerprint(form(), [xml])).not.toBe(base)
  })

  it('rechaza un sha256 que no es hexadecimal de 64 caracteres', () => {
    expect(() => computeRequestFingerprint(form(), [{ ...xml, sha256: 'ABC' }])).toThrow(TypeError)
    expect(() =>
      computeRequestFingerprint(form(), [{ ...xml, sha256: xml.sha256.toUpperCase() }]),
    ).toThrow(TypeError)
  })

  it('el formato no cambia sin querer: un cambio rompe los reintentos que crucen el despliegue', () => {
    expect(computeRequestFingerprint(form(), [xml, pdf])).toBe(
      '5250b4a590c3dc7fb26817bfd076eb1d0bcd46f105f83cba00fdde2ce1415eb9',
    )
  })
})
