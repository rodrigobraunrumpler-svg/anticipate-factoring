import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { advanceRequestFormSchema, statusChangeSchema } from './advance-request/index.js'
import { API_ERROR_MESSAGES_ES, DEFAULT_SUCCESS_MESSAGE, SUCCESS_MESSAGES_ES } from './api/index.js'
import { API_MESSAGES_ES, MESSAGES_ES, VALIDATION_MESSAGES_ES } from './errors/index.js'
import { publicPayerSchema } from './payer/index.js'

/**
 * Contrato de idioma de los esquemas que validan entrada externa: para cualquier entrada, todo
 * mensaje que devuelven (también los anidados en `issue.issues` o `issue.errors`) es uno de los
 * textos en español de `errors`. Ninguno se queda con el inglés por defecto de Zod, aunque la API
 * reciba un cuerpo sin un bloque entero o con tipos equivocados.
 */

/** Todo texto en español de `errors`: mensajes de validación y de los códigos de problema. */
const collectTexts = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : Object.values(value as Record<string, unknown>).flatMap((v) => collectTexts(v))
const SPANISH = new Set([...collectTexts(VALIDATION_MESSAGES_ES), ...Object.values(MESSAGES_ES)])

type IssueLike = {
  message: string
  issues?: readonly IssueLike[]
  errors?: readonly (readonly IssueLike[])[]
}

/** Mensajes de los issues y, recursivamente, de sus issues anidados (record, arreglo, unión). */
const messagesOf = (issues: readonly IssueLike[]): string[] =>
  issues.flatMap((issue) => [
    issue.message,
    ...messagesOf(issue.issues ?? []),
    ...(issue.errors ?? []).flatMap((group) => messagesOf(group)),
  ])

/** Mensajes que no están en `errors`: la lista vacía es el resultado esperado. */
const nonSpanishMessages = (result: z.ZodSafeParseResult<unknown>): string[] =>
  result.success ? [] : messagesOf(result.error.issues).filter((m) => !SPANISH.has(m))

type Path = readonly (string | number)[]

/** Rutas de los bloques (objetos y arreglos) y de las hojas de `value`, sin la raíz. */
function pathsOf(value: unknown, prefix: Path = []): { blocks: Path[]; leaves: Path[] } {
  const blocks: Path[] = []
  const leaves: Path[] = []
  if (value === null || typeof value !== 'object') return { blocks, leaves }
  for (const [key, child] of Object.entries(value)) {
    const path = [...prefix, Array.isArray(value) ? Number(key) : key]
    if (child !== null && typeof child === 'object') {
      const nested = pathsOf(child, path)
      blocks.push(path, ...nested.blocks)
      leaves.push(...nested.leaves)
    } else {
      leaves.push(path)
    }
  }
  return { blocks, leaves }
}

/** Copia de `value` con `replacement` en `path`. */
function setAt(value: unknown, path: Path, replacement: unknown): unknown {
  const [head, ...rest] = path
  if (head === undefined) return replacement
  if (Array.isArray(value)) {
    const copy: unknown[] = [...value]
    copy[Number(head)] = setAt(value[Number(head)], rest, replacement)
    return copy
  }
  const container = value as Record<string, unknown>
  return { ...container, [head]: setAt(container[head], rest, replacement) }
}

/** Número donde va texto; texto donde va booleano o número. */
const wrongTypeFor = (leaf: unknown): unknown => (typeof leaf === 'string' ? 1 : 'texto')

const label = (path: Path): string => (path.length === 0 ? '(raíz)' : path.join('.'))

const FORM = {
  payerSlug: 'sea',
  contact: {
    fullName: 'Ana Pérez',
    dni: '46728673',
    mobile: '987654321',
    email: 'ana@proveedor.pe',
    isLegalRepresentative: true,
    jobTitle: 'Gerenta general',
    contactTimeSlot: 'MORNING',
  },
  company: { ruc: '20100070970', legalName: 'PROVEEDOR EJEMPLO S.A.C.' },
  financing: { requestedAmount: '8000.00', purpose: 'Capital de trabajo' },
  cavaliRegistration: 'UNKNOWN',
  consents: { terms: true, personalData: true, termsVersion: '2026-09', privacyVersion: '2026-09' },
  source: { utm: { utm_source: 'linkedin' }, referrer: 'https://www.linkedin.com/' },
}

const PAYER = {
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

const STATUS_CHANGE = {
  to: 'WITHDRAWN',
  version: 3,
  closeReason: 'OTHER',
  closeReasonDetail: 'Cambió de proveedor',
}

type Case = {
  name: string
  schema: z.ZodType
  sample: unknown
  /** Rutas que se descartan en vez de invalidar la entrada (el referrer, ver `form.ts`). */
  discarded: readonly string[]
}

const CASES: readonly Case[] = [
  {
    name: 'advanceRequestFormSchema',
    schema: advanceRequestFormSchema,
    sample: FORM,
    discarded: ['source.referrer'],
  },
  { name: 'publicPayerSchema', schema: publicPayerSchema, sample: PAYER, discarded: [] },
  { name: 'statusChangeSchema', schema: statusChangeSchema, sample: STATUS_CHANGE, discarded: [] },
]

describe.each(CASES)('$name solo devuelve mensajes en español', ({ schema, sample, discarded }) => {
  const { blocks, leaves } = pathsOf(sample)

  it('la muestra es válida (si no, los demás casos no prueban nada)', () => {
    expect(schema.safeParse(sample).success).toBe(true)
  })

  it('con `{}`, `null` u otro tipo en la raíz', () => {
    for (const input of [{}, null, undefined, 'texto', 1, true, []]) {
      const r = schema.safeParse(input)
      expect(r.success, JSON.stringify(input)).toBe(false)
      expect(nonSpanishMessages(r), JSON.stringify(input)).toEqual([])
    }
  })

  // `statusChangeSchema` es plano: sin bloques anidados, este caso no aplica y no se declara.
  if (blocks.length > 0) {
    it('con cada bloque anidado como null, vacío o de otro tipo', () => {
      for (const path of blocks) {
        for (const replacement of [null, {}, [], 'texto', 1]) {
          const r = schema.safeParse(setAt(sample, path, replacement))
          const where = `${label(path)} = ${JSON.stringify(replacement)}`
          if (replacement === null) expect(r.success, where).toBe(false)
          expect(nonSpanishMessages(r), where).toEqual([])
        }
      }
    })
  }

  it('con cada campo de un tipo equivocado, de a uno y todos a la vez', () => {
    let allWrong: unknown = sample
    for (const path of leaves) {
      const replacement = wrongTypeFor(path.reduce<unknown>((v, k) => (v as never)[k], sample))
      allWrong = setAt(allWrong, path, replacement)
      const r = schema.safeParse(setAt(sample, path, replacement))
      expect(r.success, label(path)).toBe(discarded.includes(label(path)))
      expect(nonSpanishMessages(r), label(path)).toEqual([])
    }
    const r = schema.safeParse(allWrong)
    expect(r.success).toBe(false)
    expect(nonSpanishMessages(r)).toEqual([])
  })

  it('propiedad: cualquier valor JSON en cualquier ruta', () => {
    const paths: Path[] = [[], ...blocks, ...leaves]
    fc.assert(
      fc.property(fc.constantFrom(...paths), fc.jsonValue(), (path, value) => {
        expect(nonSpanishMessages(schema.safeParse(setAt(sample, path, value)))).toEqual([])
      }),
      { numRuns: 300 },
    )
  })
})

/**
 * Los textos que la API y la landing muestran tal cual (problemas de negocio y respuestas de la API)
 * son frases completas en español: empiezan con mayúscula, terminan en punto, sin espacios de más, y
 * sus marcadores `{nombre}` están bien cerrados. Los de la API no llevan marcadores: nadie los
 * completa antes de enviarlos. Las plantillas de los topes (`API_MESSAGES_ES.limits`) sí: las completa
 * su función de `@anticipate/shared/api` (`tooManyFilesMessage`).
 */
describe('textos de los problemas y de las respuestas de la API', () => {
  const problemTexts = Object.entries(MESSAGES_ES)
  const apiTexts: [string, string][] = [
    ...Object.entries(API_ERROR_MESSAGES_ES),
    ['DEFAULT_SUCCESS_MESSAGE', DEFAULT_SUCCESS_MESSAGE],
    ...Object.entries(SUCCESS_MESSAGES_ES),
  ]
  const apiTemplates: [string, string][] = Object.entries(API_MESSAGES_ES.limits)

  it('son frases completas', () => {
    for (const [key, text] of [...problemTexts, ...apiTexts, ...apiTemplates]) {
      expect(text, key).toBe(text.trim())
      expect(text, key).toMatch(/^\p{Lu}/u)
      expect(text.endsWith('.'), key).toBe(true)
      expect(text, key).not.toMatch(/ {2}/)
    }
  })

  it('los marcadores de los problemas y de las plantillas de la API están bien cerrados', () => {
    for (const [key, text] of [...problemTexts, ...apiTemplates]) {
      expect(text.replace(/\{\w+\}/g, ''), key).not.toMatch(/[{}]/)
    }
    for (const [key, text] of apiTemplates) expect(text, key).toMatch(/\{\w+\}/)
  })

  it('los de la API no llevan marcadores y, con las plantillas, son exactamente los de errors', () => {
    for (const [key, text] of apiTexts) expect(text, key).not.toMatch(/[{}]/)
    expect(collectTexts(API_MESSAGES_ES).sort()).toEqual(
      [...apiTexts, ...apiTemplates].map(([, text]) => text).sort(),
    )
  })
})
