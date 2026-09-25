import { createHash } from 'node:crypto'
import { formatPublicCode } from '@anticipate/shared/advance-request'
import { invoiceKey } from '@anticipate/shared/invoice'
import { type Amount, type Currency, percentOf, sumAmounts } from '@anticipate/shared/money'
import type { Payer, Supplier } from '#/infrastructure/prisma/generated/client.js'
import { newId } from '#/infrastructure/prisma/id.js'
import type { PrismaService } from '#/infrastructure/prisma/index.js'

/**
 * Pagador de prueba. Cumple `publicPayerSchema` y todas las CHECK de `payers` (RUC válido, slug,
 * color, largos y textos), así que sirve igual antes y después de la migración `integrity`.
 */
export const SEA = {
  slug: 'sea',
  ruc: '20131312955',
  legalName: 'Servicios Energéticos Ambientales S.A.',
  shortName: 'SEA',
  advancePercent: '80.00',
  minTermDays: 15,
  maxInvoices: 10,
  allowedCurrencies: ['PEN', 'USD'] as Currency[],
  accentColor: '#0E7C86',
  logoUrl: null as string | null,
  texts: { title: 'Adelanta tus facturas a SEA' } as Record<string, string>,
}

export type PayerOverrides = Partial<typeof SEA> & { active?: boolean }

export const createPayer = (prisma: PrismaService, overrides: PayerOverrides = {}) =>
  prisma.payer.create({ data: { ...SEA, ...overrides } })

/** Proveedor de prueba: RUC válido (módulo 11) y razón social no vacía. */
export const TEST_SUPPLIER = { ruc: '20100070970', legalName: 'PROVEEDOR EJEMPLO S.A.C.' }

export const createSupplier = (prisma: PrismaService, ruc: string = TEST_SUPPLIER.ruc) =>
  prisma.supplier.create({ data: { ruc, legalName: TEST_SUPPLIER.legalName } })

/** Versión que envía el formulario de prueba en `termsVersion` y `privacyVersion`. */
export const TEST_LEGAL_VERSION = '2026-09'

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

/** Versiones legales vigentes de los tests. `truncateAll` las vuelve a insertar. */
export const TEST_LEGAL_DOCUMENT_VERSIONS = [
  {
    type: 'TERMS' as const,
    version: TEST_LEGAL_VERSION,
    url: 'https://anticipate.test/legal/terminos/2026-09',
    sha256: sha256('Términos y condiciones de prueba 2026-09'),
    publishedAt: new Date('2026-09-01T05:00:00.000Z'),
    retiredAt: null as Date | null,
  },
  {
    type: 'PERSONAL_DATA' as const,
    version: TEST_LEGAL_VERSION,
    url: 'https://anticipate.test/legal/datos-personales/2026-09',
    sha256: sha256('Política de datos personales de prueba 2026-09'),
    publishedAt: new Date('2026-09-01T05:00:00.000Z'),
    retiredAt: null as Date | null,
  },
]

export type LegalDocumentVersionInput = (typeof TEST_LEGAL_DOCUMENT_VERSIONS)[number]

/** Inserta versiones legales sin pisar las que ya existen. Devuelve cuántas insertó. */
export async function createLegalDocumentVersions(
  prisma: PrismaService,
  versions: readonly LegalDocumentVersionInput[] = TEST_LEGAL_DOCUMENT_VERSIONS,
): Promise<number> {
  const result = await prisma.legalDocumentVersion.createMany({
    data: [...versions],
    skipDuplicates: true,
  })
  return result.count
}

/** Una factura del agregado de prueba. Sin datos, cumple todas las CHECK de la migración integrity. */
export type CompleteInvoiceInput = {
  /** Por defecto, una serie nueva en cada llamada (`F001-00000001`, luego `F001-00000002`). */
  seriesNumber?: string
  total?: Amount
  netPendingAmount?: Amount
  issueDate?: string
  installments?: readonly { amount: Amount; dueDate: string }[]
  withPdf?: boolean
}

export type CompleteAdvanceRequestOverrides = {
  /** Por defecto, el pagador `SEA.slug` (se crea con `createPayer` si no existe). */
  payer?: Pick<Payer, 'id' | 'ruc' | 'advancePercent' | 'minTermDays'>
  /** Por defecto, el primer proveedor de la base (se crea con `createSupplier` si no hay). */
  supplier?: Pick<Supplier, 'id' | 'ruc' | 'legalName'>
  invoices?: readonly CompleteInvoiceInput[]
  currency?: 'PEN' | 'USD'
  /** Por defecto, el máximo: `percentOf(totalNetPending, advancePercent)`. */
  requestedAmount?: Amount
  correlationId?: string | null
  /** Partes que se omiten a propósito, para probar que la base rechaza la solicitud incompleta. */
  omit?: readonly ('invoices' | 'consents' | 'initialHistory')[]
}

export type CompleteAdvanceRequest = {
  id: string
  publicCode: string
  payerId: string
  payerRuc: string
  supplierId: string
  supplierRuc: string
  invoices: { id: string; invoiceKey: string; xmlFileId: string; pdfFileId: string | null }[]
  fileIds: string[]
}

/** El mismo cliente que reciben las fábricas de la Tarea 6. */
type FactoryPrisma = Parameters<typeof createPayer>[0]

const TEST_BUCKET = 'anticipate-test'
let invoiceSequence = 0

const dbDate = (isoDate: string): Date => new Date(`${isoDate}T00:00:00.000Z`)

/**
 * Crea una solicitud completa en una sola transacción, como lo hace la API: archivos ATTACHED,
 * solicitud con su foto de condiciones, facturas con cuotas, los dos consentimientos vigentes y el
 * historial inicial. La base rechaza al confirmar una solicitud a la que le falte algo
 * (trigger advance_requests_complete). El código público sale de advance_request_code_seq.
 */
export async function createCompleteAdvanceRequest(
  prisma: FactoryPrisma,
  overrides: CompleteAdvanceRequestOverrides = {},
): Promise<CompleteAdvanceRequest> {
  const payer =
    overrides.payer ??
    (await prisma.payer.findUnique({ where: { slug: SEA.slug } })) ??
    (await createPayer(prisma))
  const supplier =
    overrides.supplier ??
    (await prisma.supplier.findFirst({ orderBy: { createdAt: 'asc' } })) ??
    (await createSupplier(prisma))
  const omit = new Set(overrides.omit ?? [])
  const currency = overrides.currency ?? 'PEN'

  const invoices = (overrides.invoices ?? [{}]).map((input) => {
    invoiceSequence += 1
    const seriesNumber = input.seriesNumber ?? `F001-${String(invoiceSequence).padStart(8, '0')}`
    const netPendingAmount = input.netPendingAmount ?? '10620.00'
    const installments = input.installments ?? [{ amount: netPendingAmount, dueDate: '2026-11-30' }]
    const dueDates = installments.map((installment) => installment.dueDate).sort()
    return {
      id: newId(),
      seriesNumber,
      invoiceKey: invoiceKey({ issuerRuc: supplier.ruc, seriesNumber }),
      total: input.total ?? '11800.00',
      netPendingAmount,
      issueDate: input.issueDate ?? '2026-09-01',
      dueDate: dueDates.at(-1) ?? '2026-11-30',
      earliestDueDate: dueDates[0] ?? '2026-11-30',
      installments,
      xmlFileId: newId(),
      pdfFileId: input.withPdf === true ? newId() : null,
    }
  })
  const totalNetPending = sumAmounts(...invoices.map((invoice) => invoice.netPendingAmount))
  const maxAmount = percentOf(totalNetPending, Number(payer.advancePercent))
  const earliestDueDate =
    invoices.map((invoice) => invoice.earliestDueDate).sort()[0] ?? '2026-11-30'
  const id = newId()
  const files = invoices.flatMap((invoice) => [
    { id: invoice.xmlFileId, purpose: 'INVOICE_XML' as const, contentType: 'application/xml' },
    ...(invoice.pdfFileId === null
      ? []
      : [
          {
            id: invoice.pdfFileId,
            purpose: 'INVOICE_PDF' as const,
            contentType: 'application/pdf',
          },
        ]),
  ])

  return prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<
      { sequence: bigint }[]
    >`SELECT nextval('advance_request_code_seq') AS sequence`
    const publicCode = formatPublicCode({
      prefix: 'ANT',
      year: 2026,
      sequence: Number(row?.sequence),
    })
    const attachedAt = new Date()

    await tx.storedFile.createMany({
      data: files.map((file) => ({
        id: file.id,
        storageBucket: TEST_BUCKET,
        key: `advance-requests/${id}/${file.id}`,
        purpose: file.purpose,
        contentType: file.contentType,
        sizeBytes: 1024,
        sha256: sha256(file.id),
        status: 'ATTACHED' as const,
        attachedAt,
      })),
    })
    await tx.advanceRequest.create({
      data: {
        id,
        publicCode,
        idempotencyKey: newId(),
        requestFingerprint: sha256(id),
        payerId: payer.id,
        payerRuc: payer.ruc,
        supplierId: supplier.id,
        supplierRuc: supplier.ruc,
        supplierLegalName: supplier.legalName,
        contactFullName: 'Ana Pérez',
        contactDni: '46728673',
        contactMobile: '987654321',
        contactEmail: 'ana@proveedor.pe',
        isLegalRepresentative: false,
        contactJobTitle: 'Gerente de finanzas',
        contactTimeSlot: 'MORNING',
        requestedAmount: overrides.requestedAmount ?? maxAmount,
        currency,
        appliedAdvancePercent: payer.advancePercent,
        appliedMinTermDays: payer.minTermDays,
        totalNetPending,
        maxAmount,
        cavaliRegistration: 'UNKNOWN',
        correlationId: overrides.correlationId ?? null,
        invoiceCount: invoices.length,
        earliestDueDate: dbDate(earliestDueDate),
      },
    })
    if (!omit.has('invoices')) {
      for (const invoice of invoices) {
        await tx.invoice.create({
          data: {
            id: invoice.id,
            advanceRequestId: id,
            requestStatus: 'NEW',
            currency,
            issuerRuc: supplier.ruc,
            recipientRuc: payer.ruc,
            documentType: '01',
            seriesNumber: invoice.seriesNumber,
            invoiceKey: invoice.invoiceKey,
            issuerName: supplier.legalName,
            paymentTerms: 'CREDIT',
            total: invoice.total,
            netPendingAmount: invoice.netPendingAmount,
            issueDate: dbDate(invoice.issueDate),
            dueDate: dbDate(invoice.dueDate),
            signed: true,
            xmlFileId: invoice.xmlFileId,
            pdfFileId: invoice.pdfFileId,
            installments: {
              create: invoice.installments.map((installment, index) => ({
                number: index + 1,
                label: `Cuota${String(index + 1).padStart(3, '0')}`,
                amount: installment.amount,
                dueDate: dbDate(installment.dueDate),
              })),
            },
          },
        })
      }
    }
    if (!omit.has('consents')) {
      const versions = await tx.legalDocumentVersion.findMany({
        where: { retiredAt: null },
        orderBy: { publishedAt: 'desc' },
      })
      const current = (type: 'TERMS' | 'PERSONAL_DATA'): string => {
        const version = versions.find((candidate) => candidate.type === type)
        if (!version) {
          throw new Error(`No hay una versión vigente de ${type}: truncateAll las vuelve a crear.`)
        }
        return version.version
      }
      await tx.consent.createMany({
        data: (['TERMS', 'PERSONAL_DATA'] as const).map((type) => ({
          advanceRequestId: id,
          type,
          documentVersion: current(type),
          ip: '203.0.113.10',
          userAgent: 'vitest',
          acceptedAt: attachedAt,
        })),
      })
    }
    if (!omit.has('initialHistory')) {
      await tx.statusHistory.create({
        data: {
          advanceRequestId: id,
          fromStatus: null,
          toStatus: 'NEW',
          version: 1,
          correlationId: overrides.correlationId ?? null,
        },
      })
    }

    return {
      id,
      publicCode,
      payerId: payer.id,
      payerRuc: payer.ruc,
      supplierId: supplier.id,
      supplierRuc: supplier.ruc,
      invoices: invoices.map(({ id: invoiceId, invoiceKey: key, xmlFileId, pdfFileId }) => ({
        id: invoiceId,
        invoiceKey: key,
        xmlFileId,
        pdfFileId,
      })),
      fileIds: files.map((file) => file.id),
    }
  })
}
