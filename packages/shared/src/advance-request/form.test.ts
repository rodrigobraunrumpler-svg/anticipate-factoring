import { describe, expect, it } from 'vitest'
import { MESSAGES_ES, VALIDATION_MESSAGES_ES } from '../errors/index.js'
import {
  type AdvanceRequestForm,
  advanceRequestFormSchema,
  CAVALI_REGISTRATION,
  CAVALI_REGISTRATION_LABELS,
  type CavaliRegistration,
  CONTACT_TIME_SLOT_LABELS,
  CONTACT_TIME_SLOTS,
  type ContactTimeSlot,
  FORM_MESSAGES,
} from './form.js'

/** Todo texto de validación en español que puede devolver el formulario. */
const spanishMessages = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : Object.values(value as Record<string, unknown>).flatMap((v) => spanishMessages(v))

const valid = {
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

  it('recorta la versión de términos y de privacidad; solo espacios es que falta', () => {
    // Gemela de la CHECK `btrim(document_version) <> ''` de consents: una versión en blanco haría
    // fallar el INSERT del consentimiento en vez de volver con su campo.
    const r = advanceRequestFormSchema.parse({
      ...valid,
      consents: { ...valid.consents, termsVersion: ' 2026-09 ', privacyVersion: '\t2026-09\n' },
    })
    expect([r.consents.termsVersion, r.consents.privacyVersion]).toEqual(['2026-09', '2026-09'])
    for (const blank of [' ', '\u2029', ' \u3000 ']) {
      const terms = advanceRequestFormSchema.safeParse({
        ...valid,
        consents: { ...valid.consents, termsVersion: blank },
      })
      expect(terms.success).toBe(false)
      if (!terms.success) expect(terms.error.issues[0]?.message).toBe(FORM_MESSAGES.termsVersionMin)
      const privacy = advanceRequestFormSchema.safeParse({
        ...valid,
        consents: { ...valid.consents, privacyVersion: blank },
      })
      expect(privacy.success).toBe(false)
      if (!privacy.success) {
        expect(privacy.error.issues[0]?.message).toBe(FORM_MESSAGES.privacyVersionMin)
      }
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
      // El referrer inválido se descarta a propósito (P2); el problema viene de la clave utm.
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

  describe('URL de referencia (dato de analítica que pone el navegador)', () => {
    const withReferrer = (referrer: unknown) =>
      advanceRequestFormSchema.safeParse({ ...valid, source: { ...valid.source, referrer } })

    it('se descarta, sin invalidar el formulario, si no es http(s) o supera el tope', () => {
      const discarded: unknown[] = [
        'android-app://com.google.android.googlequicksearchbox/',
        'javascript:alert(1)',
        'data:text/html,x',
        'ftp://ejemplo.pe/x',
        'http://localhost:4321/sea',
        'not-a-url',
        `https://ejemplo.pe/${'a'.repeat(1982)}`, // 2001 caracteres
        `https://ejemplo.pe/${'a'.repeat(5000)}`,
        42,
        null,
      ]
      for (const referrer of discarded) {
        const r = withReferrer(referrer)
        expect(r.success, String(referrer)).toBe(true)
        if (r.success) {
          expect(r.data.source?.referrer, String(referrer)).toBeUndefined()
          // El resto de `source` se conserva.
          expect(r.data.source?.utm).toEqual({ utm_source: 'linkedin' })
        }
      }
    })

    it('se conserva si es una URL http(s) de hasta 2000 caracteres', () => {
      const google = withReferrer('https://www.google.com/search?q=adelanto')
      expect(google.success && google.data.source?.referrer).toBe(
        'https://www.google.com/search?q=adelanto',
      )
      const atLimit = `https://ejemplo.pe/${'a'.repeat(1981)}` // 2000 caracteres
      expect(atLimit).toHaveLength(2000)
      const r = withReferrer(atLimit)
      expect(r.success && r.data.source?.referrer).toBe(atLimit)
    })

    it('una clave utm inválida sigue invalidando el formulario, aunque el referrer se descarte', () => {
      const r = advanceRequestFormSchema.safeParse({
        ...valid,
        source: { utm: { password: 'x' }, referrer: 'android-app://com.google.android.gm/' },
      })
      expect(r.success).toBe(false)
      if (!r.success) {
        expect(r.error.issues.length).toBeGreaterThan(0)
        for (const issue of r.error.issues) {
          expect(issue.path.slice(0, 2)).toEqual(['source', 'utm'])
          expect(issue.message).toBe(FORM_MESSAGES.utmKey)
        }
      }
    })
  })

  describe('caracteres que la base no guarda (gemela del tipo de sus columnas)', () => {
    /** Copia de `valid` con `value` en `path`. */
    const withField = (path: readonly string[], value: unknown): unknown => {
      const copy = structuredClone(valid) as Record<string, unknown>
      let node = copy
      for (const key of path.slice(0, -1)) node = node[key] as Record<string, unknown>
      node[path.at(-1) as string] = value
      return copy
    }
    // U+0000: PostgreSQL no lo guarda en texto (22021) ni en jsonb (22P05). Sustituto suelto: en
    // texto llegaría cambiado por U+FFFD y en jsonb es 22P02. Control C0 y U+FFFF: XML 1.0 no los
    // admite (misma regla que el lector del XML).
    const FORBIDDEN = ['\u0000', '\uD800', '\uDFFF', '\u0001', '\u001F', '\uFFFE', '\uFFFF']
    /** `U+0000` en vez del carácter crudo, para el nombre del test. */
    const codeOf = (ch: string) =>
      `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`
    const FIELDS: { path: string[]; around: [string, string]; message: string }[] = [
      { path: ['contact', 'fullName'], around: ['Ana', 'Pérez'], message: FORM_MESSAGES.fullName },
      {
        path: ['company', 'legalName'],
        around: ['PROV', 'EEDOR S.A.C.'],
        message: FORM_MESSAGES.legalName,
      },
      {
        path: ['financing', 'purpose'],
        around: ['Capital', 'de trabajo'],
        message: FORM_MESSAGES.purpose,
      },
      {
        path: ['consents', 'termsVersion'],
        around: ['2026', '09'],
        message: FORM_MESSAGES.termsVersion,
      },
      {
        path: ['consents', 'privacyVersion'],
        around: ['2026', '09'],
        message: FORM_MESSAGES.privacyVersion,
      },
      {
        path: ['source', 'utm', 'utm_source'],
        around: ['linked', 'in'],
        message: FORM_MESSAGES.utmValue,
      },
    ]

    it.each(
      FIELDS.flatMap((field) =>
        FORBIDDEN.map((ch) => ({
          ...field,
          ch,
          label: `${field.path.join('.')} con ${codeOf(ch)}`,
        })),
      ),
    )('rechaza $label, con su mensaje', ({ path, around, message, ch }) => {
      const r = advanceRequestFormSchema.safeParse(withField(path, `${around[0]}${ch}${around[1]}`))
      expect(r.success).toBe(false)
      if (!r.success) {
        expect(r.error.issues.map((issue) => [issue.path.join('.'), issue.message])).toEqual([
          [path.join('.'), message],
        ])
      }
    })

    it.each(FORBIDDEN.map((ch) => [codeOf(ch), ch]))(
      'rechaza el cargo con %s, con su mensaje',
      (_, ch) => {
        const r = advanceRequestFormSchema.safeParse({
          ...valid,
          contact: { ...valid.contact, isLegalRepresentative: false, jobTitle: `Gere${ch}nte` },
        })
        expect(r.success).toBe(false)
        if (!r.success) {
          expect(r.error.issues.map((issue) => [issue.path.join('.'), issue.message])).toEqual([
            ['contact.jobTitle', FORM_MESSAGES.jobTitle],
          ])
        }
      },
    )

    it.each(FORBIDDEN.map((ch) => [codeOf(ch), ch]))(
      'descarta una URL de referencia con %s, sin invalidar el formulario',
      (_, ch) => {
        const r = advanceRequestFormSchema.safeParse(
          withField(['source', 'referrer'], `https://www.linkedin.com/x${ch}y`),
        )
        expect(r.success).toBe(true)
        if (r.success) {
          expect(r.data.source?.referrer).toBeUndefined()
          expect(r.data.source?.utm).toEqual({ utm_source: 'linkedin' })
        }
      },
    )

    it('acepta tildes, eñes, tabulación, saltos de línea, emoji y caracteres de uso privado', () => {
      const text = 'Ñandú\tÁéíóú\nCastañeda 😀 \uE000 \uFFFD'
      const r = advanceRequestFormSchema.parse({
        ...valid,
        contact: {
          ...valid.contact,
          fullName: text,
          isLegalRepresentative: false,
          jobTitle: text,
        },
        company: { ...valid.company, legalName: text },
        financing: { ...valid.financing, purpose: text },
        source: { utm: { utm_source: text }, referrer: 'https://ejemplo.pe/ñandú?q=😀' },
      })
      expect([
        r.contact.fullName,
        r.contact.jobTitle,
        r.company.legalName,
        r.financing.purpose,
        r.source?.utm?.utm_source,
      ]).toEqual([text, text, text, text, text])
      expect(r.source?.referrer).toBe('https://ejemplo.pe/ñandú?q=😀')
    })
  })

  it('identifica al pagador con su slug', () => {
    const { payerSlug: _omitted, ...withoutPayer } = valid
    expect(advanceRequestFormSchema.safeParse(withoutPayer).success).toBe(false)
    for (const payerSlug of ['SEA', 'sea 2', '']) {
      const r = advanceRequestFormSchema.safeParse({ ...valid, payerSlug })
      expect(r.success, payerSlug).toBe(false)
      if (!r.success) {
        expect(Object.values(VALIDATION_MESSAGES_ES.payer)).toContain(r.error.issues[0]?.message)
      }
    }
    expect(advanceRequestFormSchema.parse(valid).payerSlug).toBe('sea')
  })
})

describe('etiquetas y tipos del formulario', () => {
  it('toda opción de horario y de Cavali tiene etiqueta en español', () => {
    for (const slot of CONTACT_TIME_SLOTS) expect(CONTACT_TIME_SLOT_LABELS[slot]).toBeTruthy()
    for (const option of CAVALI_REGISTRATION)
      expect(CAVALI_REGISTRATION_LABELS[option]).toBeTruthy()
    expect(Object.keys(CAVALI_REGISTRATION_LABELS).sort()).toEqual([...CAVALI_REGISTRATION].sort())
  })

  it('exporta los tipos de las opciones y las tablas son de solo lectura', () => {
    const slot: ContactTimeSlot = 'MORNING'
    const cavali: CavaliRegistration = 'UNKNOWN'
    const form: AdvanceRequestForm['cavaliRegistration'] = cavali
    expect([slot, form]).toEqual(['MORNING', 'UNKNOWN'])
    // Nunca se ejecuta: solo comprueba con `tsc` que las tablas no se pueden modificar.
    const mutate = () => {
      // @ts-expect-error la tabla es de solo lectura
      CAVALI_REGISTRATION_LABELS.YES = 'x'
      // @ts-expect-error la tabla es de solo lectura
      CONTACT_TIME_SLOT_LABELS.ANY = 'x'
    }
    expect(mutate).toBeTypeOf('function')
  })
})
