/**
 * Construye XML UBL 2.1 con la forma de una factura electrónica de SUNAT, para tests y para el modo
 * demostración de la landing. No es un XML válido ante SUNAT (no está firmado de verdad).
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
  legacyRucPath: false,
  bom: false,
  declaredEncoding: 'UTF-8',
  windowsLineEndings: false,
  omit: [],
} as const satisfies Required<TestXmlOptions>

export function buildInvoiceXml(options: TestXmlOptions = {}): string {
  const o = { ...DEFAULT_TEST_XML, ...options }
  const cbc = (t: string) => (o.prefixes.cbc ? `${o.prefixes.cbc}:${t}` : t)
  const cac = (t: string) => (o.prefixes.cac ? `${o.prefixes.cac}:${t}` : t)
  const el = (name: string, content: string, attributes = ''): string =>
    `<${name}${attributes}>${content}</${name}>`
  const omitted = (name: (typeof o.omit)[number]) => o.omit.includes(name)
  const money = (name: string, value: string) => el(cbc(name), value, ` currencyID="${o.currency}"`)

  const party = (
    role: 'AccountingSupplierParty' | 'AccountingCustomerParty',
    ruc: string,
    name: string | null,
  ) =>
    el(
      cac(role),
      el(
        cac('Party'),
        o.legacyRucPath
          ? el(
              cac('PartyTaxScheme'),
              (name === null ? '' : el(cbc('RegistrationName'), name)) +
                el(cbc('CompanyID'), ruc, ' schemeID="6"'),
            )
          : el(cac('PartyIdentification'), el(cbc('ID'), ruc, ' schemeID="6"')) +
              (name === null ? '' : el(cac('PartyLegalEntity'), el(cbc('RegistrationName'), name))),
      ),
    )

  const paymentTermsBlocks: string[] = []
  if (o.detraction) {
    paymentTermsBlocks.push(
      el(
        cac('PaymentTerms'),
        el(cbc('ID'), 'Detraccion') +
          el(cbc('PaymentMeansID'), '001') +
          el(cbc('PaymentPercent'), o.detraction.percent) +
          money('Amount', o.detraction.amount),
      ),
    )
  }
  if (o.paymentTerms) {
    paymentTermsBlocks.push(
      el(
        cac('PaymentTerms'),
        el(cbc('ID'), 'FormaPago') +
          el(cbc('PaymentMeansID'), o.paymentTerms) +
          (o.paymentTerms === 'Credito' && o.netPendingAmount !== null
            ? money('Amount', o.netPendingAmount)
            : ''),
      ),
    )
  }
  for (const i of o.installments) {
    paymentTermsBlocks.push(
      el(
        cac('PaymentTerms'),
        el(cbc('ID'), 'FormaPago') +
          el(cbc('PaymentMeansID'), i.id) +
          money('Amount', i.amount) +
          el(cbc('PaymentDueDate'), i.dueDate),
      ),
    )
  }

  const signature = o.signed
    ? el(
        'ext:UBLExtensions',
        el(
          'ext:UBLExtension',
          el(
            'ext:ExtensionContent',
            el('ds:Signature', el('ds:SignatureValue', 'ZmlybWE='), ' Id="SignSUNAT"'),
          ),
        ),
      )
    : ''

  const typeTag = o.root === 'CreditNote' ? 'CreditNoteTypeCode' : 'InvoiceTypeCode'
  const body = [
    signature,
    el(cbc('UBLVersionID'), '2.1'),
    el(cbc('CustomizationID'), '2.0'),
    omitted('ID') ? '' : el(cbc('ID'), o.seriesNumber),
    omitted('IssueDate') ? '' : el(cbc('IssueDate'), o.issueDate),
    omitted('InvoiceTypeCode') ? '' : el(cbc(typeTag), o.documentType, ' listID="0101"'),
    omitted('DocumentCurrencyCode') ? '' : el(cbc('DocumentCurrencyCode'), o.currency),
    party('AccountingSupplierParty', o.issuerRuc, o.issuerName),
    party('AccountingCustomerParty', o.recipientRuc, o.recipientName),
    ...paymentTermsBlocks,
    el(
      cac('LegalMonetaryTotal'),
      money('TaxInclusiveAmount', o.total) +
        (omitted('PayableAmount') ? '' : money('PayableAmount', o.total)),
    ),
  ].join('\n  ')

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

  let xml = `<?xml version="1.0" encoding="${o.declaredEncoding}"?>\n<${o.root} ${namespaces.join(' ')}>\n  ${body}\n</${o.root}>\n`
  if (o.windowsLineEndings) xml = xml.replace(/\n/g, '\r\n')
  if (o.bom) xml = `﻿${xml}`
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
