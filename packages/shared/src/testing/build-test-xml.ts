/**
 * Construye XML UBL 2.1 con la forma de una factura electrónica de SUNAT, para tests y para el modo
 * demostración de la landing. No es un XML válido ante SUNAT (no está firmado de verdad). Se publica
 * en `@anticipate/shared/testing`, fuera de los puntos de entrada de producción.
 *
 * Todo texto y todo atributo que emite se escapa (`&`, `<`, `>`, `"`): un nombre como `A & B` produce
 * XML válido que el lector devuelve como `A & B`. Para probar referencias de carácter o XML mal
 * formado, los tests reemplazan texto en el XML ya construido.
 */
export type TestInstallment = { id: string; amount: string; dueDate: string }

export type TestXmlOptions = {
  root?: 'Invoice' | 'CreditNote' | 'ApplicationResponse'
  /** Prefijos de espacio de nombres. `''` produce elementos sin prefijo. */
  prefixes?: { cbc: string; cac: string }
  documentType?: string
  seriesNumber?: string
  issueDate?: string
  currency?: string
  issuerRuc?: string
  issuerName?: string
  recipientRuc?: string
  recipientName?: string | null
  total?: string
  paymentTerms?: 'Contado' | 'Credito' | null
  netPendingAmount?: string | null
  installments?: TestInstallment[]
  detraction?: { percent: string; amount: string } | null
  signed?: boolean
  /** Agrega un `ext:UBLExtension` sin firma antes del que lleva la firma (como varios sistemas reales). */
  extensionBeforeSignature?: boolean
  /** Agrega el `cac:Signature` de primer nivel que referencia a la firma (como las facturas de SUNAT). */
  signatoryReference?: boolean
  /** Emite las razones sociales dentro de `<![CDATA[…]]>`, sin escapar. */
  cdataNames?: boolean
  /** Emite el RUC por la ruta legada PartyTaxScheme/CompanyID en vez de PartyIdentification/ID. */
  legacyRucPath?: boolean
  bom?: boolean
  declaredEncoding?: string
  windowsLineEndings?: boolean
  /** Elementos a omitir, para probar datos obligatorios ausentes. */
  omit?: Array<'ID' | 'IssueDate' | 'DocumentCurrencyCode' | 'InvoiceTypeCode' | 'PayableAmount'>
}

export const DEFAULT_TEST_XML = {
  root: 'Invoice',
  prefixes: { cbc: 'cbc', cac: 'cac' },
  documentType: '01',
  seriesNumber: 'F001-123',
  issueDate: '2026-09-01',
  currency: 'PEN',
  issuerRuc: '20100070970',
  issuerName: 'PROVEEDOR EJEMPLO S.A.C.',
  recipientRuc: '20131312955',
  recipientName: 'SERVICIOS ENERGETICOS AMBIENTALES S.A.',
  total: '11800.00',
  paymentTerms: 'Credito',
  netPendingAmount: '10620.00',
  installments: [{ id: 'Cuota001', amount: '10620.00', dueDate: '2026-11-30' }],
  detraction: { percent: '10', amount: '1180.00' },
  signed: true,
  extensionBeforeSignature: false,
  signatoryReference: false,
  cdataNames: false,
  legacyRucPath: false,
  bom: false,
  declaredEncoding: 'UTF-8',
  windowsLineEndings: false,
  omit: [],
} as const satisfies Required<TestXmlOptions>

const XML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
}

/** Escapa `&`, `<`, `>` y `"` para usar un valor como texto o como atributo entre comillas dobles. */
export function escapeXmlText(value: string): string {
  return value.replace(/[&<>"]/g, (ch) => XML_ESCAPES[ch] ?? ch)
}

/** Sección CDATA; un `]]>` dentro del valor se parte en dos secciones, como manda XML. */
function cdata(value: string): string {
  return `<![CDATA[${value.replaceAll(']]>', ']]]]><![CDATA[>')}]]>`
}

type Attributes = Readonly<Record<string, string>>

const attributesOf = (attributes: Attributes): string =>
  Object.entries(attributes)
    .map(([key, value]) => ` ${key}="${escapeXmlText(value)}"`)
    .join('')

/** Elemento con hijos ya construidos (no se escapan). */
const node = (name: string, children: string, attributes: Attributes = {}): string =>
  `<${name}${attributesOf(attributes)}>${children}</${name}>`

/** Elemento hoja con texto, que siempre se escapa. */
const leaf = (name: string, value: string, attributes: Attributes = {}): string =>
  node(name, escapeXmlText(value), attributes)

export function buildInvoiceXml(options: TestXmlOptions = {}): string {
  const o = { ...DEFAULT_TEST_XML, ...options }
  const cbc = (t: string) => (o.prefixes.cbc ? `${o.prefixes.cbc}:${t}` : t)
  const cac = (t: string) => (o.prefixes.cac ? `${o.prefixes.cac}:${t}` : t)
  const omitted = (name: (typeof o.omit)[number]) => o.omit.includes(name)
  const money = (name: string, value: string) => leaf(cbc(name), value, { currencyID: o.currency })
  const nameElement = (tag: string, value: string) =>
    o.cdataNames ? node(tag, cdata(value)) : leaf(tag, value)

  const party = (
    role: 'AccountingSupplierParty' | 'AccountingCustomerParty',
    ruc: string,
    legalName: string | null,
  ) =>
    node(
      cac(role),
      node(
        cac('Party'),
        o.legacyRucPath
          ? node(
              cac('PartyTaxScheme'),
              (legalName === null ? '' : nameElement(cbc('RegistrationName'), legalName)) +
                leaf(cbc('CompanyID'), ruc, { schemeID: '6' }),
            )
          : node(cac('PartyIdentification'), leaf(cbc('ID'), ruc, { schemeID: '6' })) +
              (legalName === null
                ? ''
                : node(cac('PartyLegalEntity'), nameElement(cbc('RegistrationName'), legalName))),
      ),
    )

  const paymentTermsBlocks: string[] = []
  if (o.detraction) {
    paymentTermsBlocks.push(
      node(
        cac('PaymentTerms'),
        leaf(cbc('ID'), 'Detraccion') +
          leaf(cbc('PaymentMeansID'), '001') +
          leaf(cbc('PaymentPercent'), o.detraction.percent) +
          money('Amount', o.detraction.amount),
      ),
    )
  }
  if (o.paymentTerms) {
    paymentTermsBlocks.push(
      node(
        cac('PaymentTerms'),
        leaf(cbc('ID'), 'FormaPago') +
          leaf(cbc('PaymentMeansID'), o.paymentTerms) +
          (o.paymentTerms === 'Credito' && o.netPendingAmount !== null
            ? money('Amount', o.netPendingAmount)
            : ''),
      ),
    )
  }
  for (const i of o.installments) {
    paymentTermsBlocks.push(
      node(
        cac('PaymentTerms'),
        leaf(cbc('ID'), 'FormaPago') +
          leaf(cbc('PaymentMeansID'), i.id) +
          money('Amount', i.amount) +
          leaf(cbc('PaymentDueDate'), i.dueDate),
      ),
    )
  }

  const extensions: string[] = []
  if (o.extensionBeforeSignature) {
    extensions.push(
      node(
        'ext:UBLExtension',
        node(
          'ext:ExtensionContent',
          node('ext:AdditionalInformation', leaf('ext:Note', 'SIN FIRMA')),
        ),
      ),
    )
  }
  if (o.signed) {
    extensions.push(
      node(
        'ext:UBLExtension',
        node(
          'ext:ExtensionContent',
          node('ds:Signature', leaf('ds:SignatureValue', 'ZmlybWE='), { Id: 'SignSUNAT' }),
        ),
      ),
    )
  }
  const signature = extensions.length > 0 ? node('ext:UBLExtensions', extensions.join('')) : ''

  const signatoryReference = o.signatoryReference
    ? node(
        cac('Signature'),
        leaf(cbc('ID'), 'IDSignSP') +
          node(
            cac('SignatoryParty'),
            node(cac('PartyIdentification'), leaf(cbc('ID'), o.issuerRuc)) +
              node(cac('PartyName'), nameElement(cbc('Name'), o.issuerName)),
          ) +
          node(
            cac('DigitalSignatureAttachment'),
            node(cac('ExternalReference'), leaf(cbc('URI'), '#SignatureSP')),
          ),
      )
    : ''

  const typeTag = o.root === 'CreditNote' ? 'CreditNoteTypeCode' : 'InvoiceTypeCode'
  const body = [
    signature,
    leaf(cbc('UBLVersionID'), '2.1'),
    leaf(cbc('CustomizationID'), '2.0'),
    omitted('ID') ? '' : leaf(cbc('ID'), o.seriesNumber),
    omitted('IssueDate') ? '' : leaf(cbc('IssueDate'), o.issueDate),
    omitted('InvoiceTypeCode') ? '' : leaf(cbc(typeTag), o.documentType, { listID: '0101' }),
    omitted('DocumentCurrencyCode') ? '' : leaf(cbc('DocumentCurrencyCode'), o.currency),
    signatoryReference,
    party('AccountingSupplierParty', o.issuerRuc, o.issuerName),
    party('AccountingCustomerParty', o.recipientRuc, o.recipientName),
    ...paymentTermsBlocks,
    node(
      cac('LegalMonetaryTotal'),
      money('TaxInclusiveAmount', o.total) +
        (omitted('PayableAmount') ? '' : money('PayableAmount', o.total)),
    ),
  ]
    .filter((part) => part !== '')
    .join('\n  ')

  const namespaces = [
    `xmlns="urn:oasis:names:specification:ubl:schema:xsd:${o.root}-2"`,
    'xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"',
    'xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"',
    'xmlns:ds="http://www.w3.org/2000/09/xmldsig#"',
    'xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"',
  ]
  for (const p of [o.prefixes.cbc, o.prefixes.cac]) {
    if (p && p !== 'cbc' && p !== 'cac') namespaces.push(`xmlns:${p}="urn:example:${p}"`)
  }

  let xml = `<?xml version="1.0" encoding="${escapeXmlText(o.declaredEncoding)}"?>\n<${o.root} ${namespaces.join(' ')}>\n  ${body}\n</${o.root}>\n`
  if (o.windowsLineEndings) xml = xml.replace(/\n/g, '\r\n')
  if (o.bom) xml = `\uFEFF${xml}`
  return xml
}

/** Constancia de recepción (CDR) de SUNAT: no es una factura. */
export function buildCdrXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ApplicationResponse xmlns="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2"',
    '  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">',
    '  <cbc:ID>R-F001-123</cbc:ID>',
    '  <cbc:ResponseDate>2026-09-01</cbc:ResponseDate>',
    '</ApplicationResponse>',
    '',
  ].join('\n')
}
