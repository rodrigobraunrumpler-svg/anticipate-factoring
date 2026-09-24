import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { isIsoDate } from '../dates/index.js'
import { createProblem, type Problem } from '../errors/index.js'
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

function text(node: unknown): string | undefined {
  if (typeof node === 'string') return node
  if (node && typeof node === 'object' && TEXT in node) {
    const t = (node as Record<string, unknown>)[TEXT]
    return typeof t === 'string' ? t : undefined
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

/** Nombres en español para el mensaje XML_NOT_AN_INVOICE. */
const ROOT_KINDS: Record<string, string> = {
  ApplicationResponse: 'constancia de recepción (CDR)',
  CreditNote: 'nota de crédito',
  DebitNote: 'nota de débito',
  SummaryDocuments: 'resumen diario',
  VoidedDocuments: 'comunicación de baja',
}

/** Decodifica los bytes de un XML respetando su BOM o la codificación declarada en el prólogo. */
export function decodeXml(bytes: Uint8Array): string {
  const header = new TextDecoder('latin1').decode(bytes.subarray(0, 200))
  const declared = /encoding=["']([\w-]+)["']/i.exec(header)?.[1]
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  const encoding = hasBom ? 'utf-8' : (declared ?? 'utf-8')
  // `InstanceType<typeof TextDecoder>` en vez de `TextDecoder`: con lib "ES2022" (sin DOM), @types/node
  // solo declara `TextDecoder` como valor global, no como tipo.
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

  const rootName = Object.keys(document).find((k) => k !== '?xml')
  if (rootName !== 'Invoice') {
    const kind = (rootName && ROOT_KINDS[rootName]) ?? rootName ?? 'desconocido'
    return fail(createProblem('XML_NOT_AN_INVOICE', { data: { kind } }))
  }
  const inv = document.Invoice as Record<string, unknown>

  const required = (name: string, value: string | undefined): string | ParseResult =>
    value && value.length > 0
      ? value
      : fail(createProblem('XML_MISSING_REQUIRED_FIELD', { data: { field: name } }))

  const seriesNumber = required('serie y número', text(inv.ID))
  if (typeof seriesNumber !== 'string') return seriesNumber
  const issueDate = required('fecha de emisión', text(inv.IssueDate))
  if (typeof issueDate !== 'string') return issueDate
  const documentType = required('tipo de comprobante', text(inv.InvoiceTypeCode))
  if (typeof documentType !== 'string') return documentType
  const currency = required('moneda', text(inv.DocumentCurrencyCode))
  if (typeof currency !== 'string') return currency
  const issuerRuc = required('RUC del emisor', rucOf(inv, 'AccountingSupplierParty'))
  if (typeof issuerRuc !== 'string') return issuerRuc
  const recipientRuc = required('RUC del receptor', rucOf(inv, 'AccountingCustomerParty'))
  if (typeof recipientRuc !== 'string') return recipientRuc
  const rawTotal = required('total', text(path(inv, 'LegalMonetaryTotal', 'PayableAmount')))
  if (typeof rawTotal !== 'string') return rawTotal
  const total = normalizeAmount(rawTotal)
  if (total === null)
    return fail(createProblem('XML_MISSING_REQUIRED_FIELD', { data: { field: 'total' } }))
  if (!isIsoDate(issueDate)) {
    return fail(
      createProblem('XML_MISSING_REQUIRED_FIELD', { data: { field: 'fecha de emisión' } }),
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
