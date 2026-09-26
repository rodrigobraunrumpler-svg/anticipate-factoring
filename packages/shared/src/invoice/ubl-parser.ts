import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { isIsoDate } from '../dates/index.js'
import {
  createProblem,
  formatMessage,
  type Problem,
  VALIDATION_MESSAGES_ES,
} from '../errors/index.js'
import { type Amount, normalizeAmount } from '../money/index.js'
import type { PaymentTerms } from './codes.js'
import { type Installment, type ParsedInvoice, parsedInvoiceSchema } from './parsed-invoice.js'
import { isXmlCodePoint, isXmlText } from './xml-text.js'

export type ParseResult = { ok: true; invoice: ParsedInvoice } | { ok: false; problem: Problem }

const TEXT = '#text'

// Sin `cdataPropName`: `inlineCdata` convierte cada sección CDATA en texto escapado antes de
// `parse`, así el texto de un elemento llega entero y en orden a `decodeEntities`.
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

/** Marca de orden de bytes (U+FEFF) al inicio de un texto. */
const LEADING_BOM = /^\uFEFF/

const FIELD_NAMES = VALIDATION_MESSAGES_ES.invoiceXml.fields
const DOCUMENT_KINDS: Readonly<Record<string, string>> =
  VALIDATION_MESSAGES_ES.invoiceXml.documentKinds

type InvoiceField = keyof ParsedInvoice

/**
 * Decodifica en una sola pasada (no recursiva) las cinco entidades predefinidas de XML y las
 * referencias numéricas de carácter (`&#209;`, `&#xD1;`). Deja intacto cualquier otro `&nombre;`:
 * con `processEntities: false` el parser nunca las tocó, así que no son entidades declaradas.
 * Una referencia numérica a algo que no es un carácter de XML 1.0 también se deja intacta, como
 * texto: fuera de Unicode o desbordada (`String.fromCodePoint` lanzaría `RangeError`), U+0000 y los
 * demás controles C0 (PostgreSQL no guarda U+0000), un sustituto suelto (se guardaría cambiado por
 * U+FFFD) y U+FFFE/U+FFFF. Así lo decodificado nunca trae un carácter que XML no admite.
 */
function decodeEntities(value: string): string {
  return value.replace(ENTITY_PATTERN, (match) => {
    if (match.startsWith('&#')) {
      const codePoint = match.startsWith('&#x')
        ? Number.parseInt(match.slice(3, -1), 16)
        : Number.parseInt(match.slice(2, -1), 10)
      return isXmlCodePoint(codePoint) ? String.fromCodePoint(codePoint) : match
    }
    return NAMED_ENTITIES[match.slice(1, -1)] ?? match
  })
}

const TEXT_ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }

/**
 * Construcciones de marcado de XML, en el orden en que se prueban en cada `<`: sección CDATA (grupo
 * 1, su contenido), comentario o instrucción de procesamiento (grupo 2) y etiqueta con sus
 * atributos entre comillas (un atributo puede traer `>` o `<![CDATA[`). Las tres primeras terminan
 * en su primer cierre; las tres formas de la etiqueta empiezan con caracteres disjuntos, así que
 * no retrocede.
 */
const MARKUP =
  /<!\[CDATA\[([\s\S]*?)\]\]>|(<!--[\s\S]*?-->|<\?[\s\S]*?\?>)|<(?:[^>"']|"[^"]*"|'[^']*')*>/g

/**
 * Reemplaza cada sección `<![CDATA[…]]>` por su contenido escapado como texto XML (`&`, `<`, `>`).
 * Así el texto de un elemento conserva su orden (`A<![CDATA[B]]>C` se lee `ABC`) y el contenido del
 * CDATA sigue siendo literal tras la única pasada de `decodeEntities` (`<![CDATA[A &amp; B]]>` se
 * lee `A &amp; B`). Recorre el XML construcción por construcción, no con una búsqueda suelta de
 * `<![CDATA[`: un comentario, una instrucción de procesamiento o un atributo que contenga ese texto
 * no abre una sección. Corre después de `XMLValidator.validate`, que ya garantizó que toda
 * construcción está cerrada.
 *
 * Devuelve null, y el XML se rechaza como ilegible, ante dos formas mal formadas que el validador
 * deja pasar:
 * - Un CDATA fuera del elemento raíz. El texto fuera de la raíz sí lo rechaza el validador; el
 *   CDATA, vuelto texto, el parser lo descartaría en silencio. Para saberlo se lleva la
 *   profundidad: una etiqueta de apertura suma, una de cierre resta, y una vacía (`<x/>`), un
 *   comentario o una instrucción no cambian nada.
 * - Un `<!` que no abre un comentario ni un CDATA (el DOCTYPE ya se rechazó antes). El parser toma
 *   cualquier `<![` como CDATA sin mirar la palabra (`<![CDATX[…]]>`) y un `<!X>` como elemento:
 *   por ahí volvería el contenido sin escapar que esta función existe para evitar.
 */
function inlineCdata(xml: string): string | null {
  let depth = 0
  let malformed = false
  const inlined = xml.replace(
    MARKUP,
    (markup, cdata: string | undefined, commentOrInstruction: string | undefined) => {
      if (cdata !== undefined) {
        if (depth === 0) malformed = true
        return cdata.replace(/[&<>]/g, (ch) => TEXT_ESCAPES[ch] ?? ch)
      }
      if (commentOrInstruction !== undefined) return markup
      if (markup.startsWith('<!') || markup.startsWith('<?')) malformed = true
      else if (markup.startsWith('</')) depth -= 1
      else if (!markup.endsWith('/>')) depth += 1
      return markup
    },
  )
  return malformed ? null : inlined
}

function asList<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

/**
 * Texto de un elemento con sus entidades decodificadas. Las secciones CDATA ya llegan como texto
 * escapado (`inlineCdata`), en su lugar dentro del elemento. Un elemento con atributos llega como
 * objeto y su texto se recorta también después de decodificar, como antes de este cambio.
 */
function text(node: unknown): string | undefined {
  if (typeof node === 'string') return decodeEntities(node)
  if (!node || typeof node !== 'object') return undefined
  const plain = (node as Record<string, unknown>)[TEXT]
  return typeof plain === 'string' ? decodeEntities(plain).trim() : undefined
}

function path(root: unknown, ...steps: string[]): unknown {
  let current: unknown = root
  for (const step of steps) {
    if (!current || typeof current !== 'object') return undefined
    current = asList((current as Record<string, unknown>)[step])[0]
  }
  return current
}

function children(node: unknown, name: string): unknown[] {
  if (!node || typeof node !== 'object') return []
  return asList((node as Record<string, unknown>)[name])
}

/** Codificación de respaldo para bytes que no son UTF-8 válido: la de los sistemas Windows en español. */
const LEGACY_ENCODING = 'windows-1252'

/** UTF-8 estricto (`fatal: true`); si los bytes no son UTF-8 válido, windows-1252. */
function decodeUtf8OrLegacy(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder(LEGACY_ENCODING).decode(bytes)
  }
}

/**
 * Decodifica los bytes de un XML. El BOM UTF-8 manda sobre cualquier declaración; si no hay BOM, se
 * respeta la codificación declarada en el prólogo cuando no es UTF-8 y el entorno la conoce. En
 * cualquier otro caso se decodifica como UTF-8 estricto y, si los bytes no lo son (un sistema que
 * declara UTF-8 pero escribe en windows-1252), como windows-1252: nunca con caracteres de reemplazo.
 */
export function decodeXml(bytes: Uint8Array): string {
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  if (hasBom) return decodeUtf8OrLegacy(bytes.subarray(3))
  const header = new TextDecoder(LEGACY_ENCODING).decode(bytes.subarray(0, 200))
  const declared = /encoding\s*=\s*["']([A-Za-z0-9._:-]+)["']/.exec(header)?.[1]
  if (declared !== undefined && !/^utf-?8$/i.test(declared)) {
    // `InstanceType<typeof TextDecoder>` en vez de `TextDecoder`: `shared` compila sin tipos de Node
    // ni del DOM y `src/env.d.ts` solo declara `TextDecoder` como valor global, no como tipo.
    let decoder: InstanceType<typeof TextDecoder> | null
    try {
      decoder = new TextDecoder(declared)
    } catch {
      decoder = null // etiqueta desconocida para el entorno: se sigue como UTF-8
    }
    if (decoder !== null) return decoder.decode(bytes)
  }
  return decodeUtf8OrLegacy(bytes)
}

function fail(problem: Problem): ParseResult {
  return { ok: false, problem }
}

function missing(key: InvoiceField, name: string): ParseResult {
  return fail(createProblem('XML_MISSING_REQUIRED_FIELD', { field: key, data: { field: name } }))
}

function invalid(key: InvoiceField, name: string): ParseResult {
  return fail(createProblem('XML_INVALID_FIELD', { field: key, data: { field: name } }))
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

/**
 * Firmada si algún `ext:UBLExtension` (no solo el primero: varios sistemas ponen antes otra
 * extensión) contiene un `ds:Signature`, o si hay un `cac:Signature` de primer nivel, que es la
 * referencia a la firma que exige SUNAT.
 */
function isSigned(inv: Record<string, unknown>): boolean {
  const extensions = children(path(inv, 'UBLExtensions'), 'UBLExtension')
  const inExtension = extensions.some(
    (extension) => path(extension, 'ExtensionContent', 'Signature') !== undefined,
  )
  return inExtension || inv.Signature !== undefined
}

/**
 * Nombre en español del dato al que apunta un issue de `parsedInvoiceSchema`. El monto y la fecha de
 * cada cuota ya se validaron en el recorrido de `PaymentTerms` (con el nombre de la cuota); lo que
 * queda de `installments` (cantidad de cuotas, identificador) se informa como "cuotas".
 */
function fieldOfIssue(issuePath: readonly PropertyKey[]): { key: InvoiceField; name: string } {
  const [first, second] = issuePath
  if (first === 'detraction') {
    return {
      key: 'detraction',
      name: second === 'percent' ? FIELD_NAMES.detractionPercent : FIELD_NAMES.detractionAmount,
    }
  }
  const key = String(first) as InvoiceField
  const names: Readonly<Record<string, string>> = FIELD_NAMES
  return { key, name: Object.hasOwn(names, key) ? (names[key] ?? key) : key }
}

export type ParseOptions = {
  /** Tope de caracteres del XML. La API lo toma de su configuración (STACK §8: 1 MB por XML). Sin tope si se omite. */
  maxLength?: number
}

export function parseUblInvoice(rawXml: string, options: ParseOptions = {}): ParseResult {
  const xml = rawXml.replace(LEADING_BOM, '')
  if (options.maxLength !== undefined && xml.length > options.maxLength) {
    return fail(createProblem('XML_TOO_LARGE'))
  }
  // Una factura de SUNAT nunca trae DOCTYPE; rechazarlo cierra de raíz la expansión de entidades.
  // `\s*` cubre también a un parser tolerante que acepte espacios entre `<!` y `DOCTYPE`.
  if (/<!\s*DOCTYPE/i.test(xml)) return fail(createProblem('XML_DOCTYPE_NOT_ALLOWED'))
  // `XMLValidator` no mira los caracteres: un U+0000 o un control C0 escrito tal cual (en un dato, un
  // comentario o un CDATA) deja al documento mal formado según XML 1.0, y en un dato leído haría
  // fallar el INSERT (PostgreSQL no guarda U+0000). Es un XML ilegible, nunca un dato aceptado.
  if (!xml.trimStart().startsWith('<') || !isXmlText(xml) || XMLValidator.validate(xml) !== true) {
    return fail(createProblem('UNREADABLE_XML'))
  }

  const inlined = inlineCdata(xml)
  if (inlined === null) return fail(createProblem('UNREADABLE_XML'))

  let document: Record<string, unknown>
  try {
    document = parser.parse(inlined) as Record<string, unknown>
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
  // Las claves que empiezan con "?" son el prólogo (`?xml`) y las instrucciones de procesamiento
  // (`?xml-stylesheet`); la primera que no lo es, es el elemento raíz.
  const rootName = Object.keys(document).find((k) => !k.startsWith('?'))
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

  const seriesNumber = text(inv.ID)
  if (!seriesNumber) return missing('seriesNumber', FIELD_NAMES.seriesNumber)
  const issueDate = text(inv.IssueDate)
  if (!issueDate) return missing('issueDate', FIELD_NAMES.issueDate)
  const documentType = text(inv.InvoiceTypeCode)
  if (!documentType) return missing('documentType', FIELD_NAMES.documentType)
  const currency = text(inv.DocumentCurrencyCode)
  if (!currency) return missing('currency', FIELD_NAMES.currency)
  const issuerRuc = rucOf(inv, 'AccountingSupplierParty')
  if (!issuerRuc) return missing('issuerRuc', FIELD_NAMES.issuerRuc)
  const recipientRuc = rucOf(inv, 'AccountingCustomerParty')
  if (!recipientRuc) return missing('recipientRuc', FIELD_NAMES.recipientRuc)
  const rawTotal = text(path(inv, 'LegalMonetaryTotal', 'PayableAmount'))
  if (!rawTotal) return missing('total', FIELD_NAMES.total)
  const total = normalizeAmount(rawTotal)
  if (total === null) return invalid('total', FIELD_NAMES.total)
  if (!isIsoDate(issueDate)) return invalid('issueDate', FIELD_NAMES.issueDate)

  let paymentTerms: PaymentTerms | null = null
  let netPendingAmount: Amount | null = null
  const installments: Installment[] = []
  let detraction: ParsedInvoice['detraction'] = null

  // Un bloque reconocido (Credito, CuotaNNN, Detraccion) con un dato mal formado es un problema de la
  // factura, nunca se descarta en silencio: descartar una cuota vencida o una detracción cambiaría el
  // resultado de las reglas sin que nadie lo note.
  for (const term of asList(inv.PaymentTerms as Node | Node[])) {
    const id = text(path(term, 'ID'))
    const means = text(path(term, 'PaymentMeansID')) ?? ''
    const rawAmount = text(path(term, 'Amount'))
    if (id === 'FormaPago') {
      if (means === 'Contado') paymentTerms = 'CASH'
      else if (means === 'Credito') {
        paymentTerms = 'CREDIT'
        if (rawAmount !== undefined) {
          netPendingAmount = normalizeAmount(rawAmount)
          if (netPendingAmount === null) {
            return invalid('netPendingAmount', FIELD_NAMES.netPendingAmount)
          }
        }
      } else if (/^Cuota\d+$/i.test(means)) {
        const amount = normalizeAmount(rawAmount ?? '')
        if (amount === null) {
          return invalid(
            'installments',
            formatMessage(FIELD_NAMES.installmentAmount, { installment: means }),
          )
        }
        const dueDate = text(path(term, 'PaymentDueDate')) ?? ''
        if (!isIsoDate(dueDate)) {
          return invalid(
            'installments',
            formatMessage(FIELD_NAMES.installmentDueDate, { installment: means }),
          )
        }
        installments.push({ id: means, amount, dueDate })
      }
    } else if (id === 'Detraccion') {
      // Un porcentaje vacío (`<PaymentPercent/>`) nunca vale 0: `Number('')` lo haría.
      const rawPercent = text(path(term, 'PaymentPercent')) ?? ''
      if (!/^\d{1,3}(?:\.\d{1,4})?$/.test(rawPercent)) {
        return invalid('detraction', FIELD_NAMES.detractionPercent)
      }
      const amount = normalizeAmount(rawAmount ?? '')
      if (amount === null) return invalid('detraction', FIELD_NAMES.detractionAmount)
      detraction = { percent: Number(rawPercent), amount }
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
    signed: isSigned(inv),
  }

  // El esquema es la única fuente de formatos y topes; cada violación se informa con el dato en
  // español, nunca como XML ilegible.
  const validated = parsedInvoiceSchema.safeParse(invoice)
  if (validated.success) return { ok: true, invoice: validated.data }
  const { key, name } = fieldOfIssue(validated.error.issues[0]?.path ?? [])
  return invalid(key, name)
}
