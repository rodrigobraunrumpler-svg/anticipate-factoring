import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { isIsoDate } from '../dates/index.js'
import { createProblem, type Problem, VALIDATION_MESSAGES_ES } from '../errors/index.js'
import { type Amount, normalizeAmount } from '../money/index.js'
import type { PaymentTerms } from './codes.js'
import { type Installment, type ParsedInvoice, parsedInvoiceSchema } from './parsed-invoice.js'

export type ParseResult = { ok: true; invoice: ParsedInvoice } | { ok: false; problem: Problem }

const TEXT = '#text'

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: TEXT,
  removeNSPrefix: true,
  processEntities: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
})

type Node = string | { [key: string]: unknown } | undefined

/** Las cinco entidades predefinidas de XML. `processEntities: false` deja todo lo demás sin tocar. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

const ENTITY_PATTERN = /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g

/** Un punto de código válido de Unicode va de 1 a 0x10FFFF; 0 y lo que excede el plano 16 no lo son. */
const MAX_CODE_POINT = 0x10ffff

/**
 * Decodifica en una sola pasada (no recursiva) las cinco entidades predefinidas de XML y las
 * referencias numéricas de carácter (`&#209;`, `&#xD1;`). Deja intacto cualquier otro `&nombre;`:
 * con `processEntities: false` el parser nunca las tocó, así que no son entidades declaradas.
 * Una referencia numérica fuera de 1..0x10FFFF (o desbordada) también se deja intacta en vez de
 * lanzar: `String.fromCodePoint` lanza `RangeError` para esos valores.
 */
function decodeEntities(value: string): string {
  return value.replace(ENTITY_PATTERN, (match) => {
    if (match.startsWith('&#')) {
      const codePoint = match.startsWith('&#x')
        ? Number.parseInt(match.slice(3, -1), 16)
        : Number.parseInt(match.slice(2, -1), 10)
      return Number.isInteger(codePoint) && codePoint >= 1 && codePoint <= MAX_CODE_POINT
        ? String.fromCodePoint(codePoint)
        : match
    }
    return NAMED_ENTITIES[match.slice(1, -1)] ?? match
  })
}

function text(node: unknown): string | undefined {
  if (typeof node === 'string') return decodeEntities(node)
  if (node && typeof node === 'object' && TEXT in node) {
    const t = (node as Record<string, unknown>)[TEXT]
    return typeof t === 'string' ? decodeEntities(t) : undefined
  }
  return undefined
}

function asList<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function path(root: unknown, ...steps: string[]): unknown {
  let current: unknown = root
  for (const step of steps) {
    if (!current || typeof current !== 'object') return undefined
    current = asList((current as Record<string, unknown>)[step])[0]
  }
  return current
}

const FIELD_NAMES = VALIDATION_MESSAGES_ES.invoiceXml.fields
const DOCUMENT_KINDS: Readonly<Record<string, string>> =
  VALIDATION_MESSAGES_ES.invoiceXml.documentKinds

/** Decodifica los bytes de un XML respetando su BOM o la codificación declarada en el prólogo. */
export function decodeXml(bytes: Uint8Array): string {
  const header = new TextDecoder('latin1').decode(bytes.subarray(0, 200))
  const declared = /encoding=["']([\w-]+)["']/i.exec(header)?.[1]
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  const encoding = hasBom ? 'utf-8' : (declared ?? 'utf-8')
  // `InstanceType<typeof TextDecoder>` en vez de `TextDecoder`: `shared` compila sin tipos de Node ni
  // del DOM y `src/env.d.ts` solo declara `TextDecoder` como valor global, no como tipo.
  let decoder: InstanceType<typeof TextDecoder>
  try {
    decoder = new TextDecoder(encoding)
  } catch {
    decoder = new TextDecoder('utf-8')
  }
  return decoder.decode(bytes).replace(/^﻿/, '')
}

function fail(problem: Problem): ParseResult {
  return { ok: false, problem }
}

/** Ruta vigente (PartyIdentification/ID) con fallback a la legada (PartyTaxScheme/CompanyID). */
function rucOf(inv: Record<string, unknown>, role: string): string | undefined {
  return (
    text(path(inv, role, 'Party', 'PartyIdentification', 'ID')) ??
    text(path(inv, role, 'Party', 'PartyTaxScheme', 'CompanyID'))
  )
}

function nameOf(inv: Record<string, unknown>, role: string): string | undefined {
  return (
    text(path(inv, role, 'Party', 'PartyLegalEntity', 'RegistrationName')) ??
    text(path(inv, role, 'Party', 'PartyTaxScheme', 'RegistrationName'))
  )
}

export type ParseOptions = {
  /** Tope de caracteres del XML. La API lo toma de su configuración (STACK §8: 1 MB por XML). Sin tope si se omite. */
  maxLength?: number
}

export function parseUblInvoice(rawXml: string, options: ParseOptions = {}): ParseResult {
  const xml = rawXml.replace(/^﻿/, '')
  if (options.maxLength !== undefined && xml.length > options.maxLength) {
    return fail(createProblem('XML_TOO_LARGE'))
  }
  // Una factura de SUNAT nunca trae DOCTYPE; rechazarlo cierra de raíz la expansión de entidades.
  if (/<!DOCTYPE/i.test(xml)) return fail(createProblem('XML_DOCTYPE_NOT_ALLOWED'))
  if (!xml.trimStart().startsWith('<') || XMLValidator.validate(xml) !== true) {
    return fail(createProblem('UNREADABLE_XML'))
  }

  let document: Record<string, unknown>
  try {
    document = parser.parse(xml) as Record<string, unknown>
  } catch {
    return fail(createProblem('UNREADABLE_XML'))
  }

  try {
    return extractInvoice(document)
  } catch {
    // Red de seguridad: parseUblInvoice nunca debe lanzar, sea cual sea el XML de entrada. Los
    // códigos de problema específicos (arriba y dentro de extractInvoice) se conservan tal cual;
    // esto solo atrapa una excepción inesperada que se escape de la extracción.
    return fail(createProblem('UNREADABLE_XML'))
  }
}

function extractInvoice(document: Record<string, unknown>): ParseResult {
  const rootName = Object.keys(document).find((k) => k !== '?xml')
  if (rootName !== 'Invoice') {
    // Object.hasOwn, no `DOCUMENT_KINDS[rootName]` directo: rootName viene de un XML no confiable y
    // podría coincidir con una propiedad heredada de Object.prototype (p. ej. "isPrototypeOf").
    const kind =
      rootName !== undefined && Object.hasOwn(DOCUMENT_KINDS, rootName)
        ? (DOCUMENT_KINDS[rootName] ?? rootName)
        : (rootName ?? VALIDATION_MESSAGES_ES.invoiceXml.unknownDocumentKind)
    return fail(createProblem('XML_NOT_AN_INVOICE', { data: { kind } }))
  }
  const inv = document.Invoice as Record<string, unknown>

  const required = (name: string, value: string | undefined): string | ParseResult =>
    value && value.length > 0
      ? value
      : fail(createProblem('XML_MISSING_REQUIRED_FIELD', { data: { field: name } }))

  const seriesNumber = required(FIELD_NAMES.seriesNumber, text(inv.ID))
  if (typeof seriesNumber !== 'string') return seriesNumber
  const issueDate = required(FIELD_NAMES.issueDate, text(inv.IssueDate))
  if (typeof issueDate !== 'string') return issueDate
  const documentType = required(FIELD_NAMES.documentType, text(inv.InvoiceTypeCode))
  if (typeof documentType !== 'string') return documentType
  const currency = required(FIELD_NAMES.currency, text(inv.DocumentCurrencyCode))
  if (typeof currency !== 'string') return currency
  const issuerRuc = required(FIELD_NAMES.issuerRuc, rucOf(inv, 'AccountingSupplierParty'))
  if (typeof issuerRuc !== 'string') return issuerRuc
  const recipientRuc = required(FIELD_NAMES.recipientRuc, rucOf(inv, 'AccountingCustomerParty'))
  if (typeof recipientRuc !== 'string') return recipientRuc
  const rawTotal = required(
    FIELD_NAMES.total,
    text(path(inv, 'LegalMonetaryTotal', 'PayableAmount')),
  )
  if (typeof rawTotal !== 'string') return rawTotal
  const total = normalizeAmount(rawTotal)
  if (total === null)
    return fail(createProblem('XML_MISSING_REQUIRED_FIELD', { data: { field: FIELD_NAMES.total } }))
  if (!isIsoDate(issueDate)) {
    return fail(
      createProblem('XML_MISSING_REQUIRED_FIELD', { data: { field: FIELD_NAMES.issueDate } }),
    )
  }

  let paymentTerms: PaymentTerms | null = null
  let netPendingAmount: Amount | null = null
  const installments: Installment[] = []
  let detraction: ParsedInvoice['detraction'] = null

  for (const term of asList(inv.PaymentTerms as Node | Node[])) {
    const id = text(path(term, 'ID'))
    const means = text(path(term, 'PaymentMeansID')) ?? ''
    const amount = normalizeAmount(text(path(term, 'Amount')) ?? '')
    if (id === 'FormaPago') {
      if (means === 'Contado') paymentTerms = 'CASH'
      else if (means === 'Credito') {
        paymentTerms = 'CREDIT'
        netPendingAmount = amount
      } else if (/^Cuota\d+$/i.test(means)) {
        const dueDate = text(path(term, 'PaymentDueDate')) ?? ''
        if (amount !== null && isIsoDate(dueDate)) installments.push({ id: means, amount, dueDate })
      }
    } else if (id === 'Detraccion') {
      const percent = Number(text(path(term, 'PaymentPercent')) ?? Number.NaN)
      if (amount !== null && Number.isFinite(percent)) detraction = { percent, amount }
    }
  }

  const invoice: ParsedInvoice = {
    documentType,
    seriesNumber,
    issueDate,
    currency,
    issuerRuc,
    issuerName: nameOf(inv, 'AccountingSupplierParty') ?? '',
    recipientRuc,
    recipientName: nameOf(inv, 'AccountingCustomerParty') ?? null,
    total,
    paymentTerms,
    netPendingAmount,
    installments,
    detraction,
    signed:
      path(inv, 'UBLExtensions', 'UBLExtension', 'ExtensionContent', 'Signature') !== undefined,
  }

  const validated = parsedInvoiceSchema.safeParse(invoice)
  return validated.success
    ? { ok: true, invoice: validated.data }
    : fail(createProblem('UNREADABLE_XML'))
}
