import type { IsoDate } from '@anticipate/shared/dates'
import { isoDateToDb } from '#/infrastructure/prisma/db-values.js'
import { Prisma } from '#/infrastructure/prisma/generated/client.js'
import type { NewAdvanceRequest, ReservedFile } from '#/modules/advance-requests/index.js'

/** Estado inicial de toda solicitud y de sus facturas (la FK de alcance exige que coincidan). */
const INITIAL_STATUS = 'NEW'

/** La menor fecha de cuota de la solicitud: `advance_requests.earliest_due_date`. */
export function earliestDueDate(request: NewAdvanceRequest): IsoDate {
  const dates = request.invoices.flatMap((invoice) => invoice.installments.map((i) => i.dueDate))
  const earliest = dates.sort().at(0)
  if (earliest === undefined) throw new TypeError(`La solicitud ${request.id} no tiene cuotas`)
  return earliest
}

export function toStoredFileRows(
  files: readonly ReservedFile[],
): Prisma.StoredFileCreateManyInput[] {
  return files.map((file) => ({
    id: file.id,
    storageBucket: file.bucket,
    key: file.key,
    purpose: file.purpose,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
  }))
}

export function toAdvanceRequestRow(
  request: NewAdvanceRequest,
  refs: { publicCode: string; supplierId: string; legalRepresentativeId: string | null },
): Prisma.AdvanceRequestUncheckedCreateInput {
  const { contact, snapshot } = request
  return {
    id: request.id,
    publicCode: refs.publicCode,
    idempotencyKey: request.idempotencyKey,
    requestFingerprint: request.requestFingerprint,
    payerId: request.payerId,
    payerRuc: request.payerRuc,
    supplierId: refs.supplierId,
    supplierRuc: request.supplier.ruc,
    supplierLegalName: request.supplierLegalName,
    status: INITIAL_STATUS,
    contactFullName: contact.fullName,
    contactDni: contact.dni,
    contactMobile: contact.mobile,
    contactEmail: contact.email,
    isLegalRepresentative: contact.isLegalRepresentative,
    legalRepresentativeId: refs.legalRepresentativeId,
    contactJobTitle: contact.jobTitle,
    contactTimeSlot: contact.contactTimeSlot,
    requestedAmount: request.requestedAmount,
    currency: request.currency,
    appliedAdvancePercent: snapshot.appliedAdvancePercent,
    appliedMinTermDays: snapshot.appliedMinTermDays,
    totalNetPending: snapshot.totalNetPending,
    maxAmount: snapshot.maxAmount,
    purpose: request.purpose,
    cavaliRegistration: request.cavaliRegistration,
    utm: request.utm === null ? Prisma.DbNull : { ...request.utm },
    referrer: request.referrer,
    correlationId: request.correlationId,
    invoiceCount: request.invoices.length,
    earliestDueDate: isoDateToDb(earliestDueDate(request)),
    createdAt: request.createdAt,
  }
}

/** Orden total por `invoiceKey` (unidades de código, sin colación): el mismo en todo proceso. */
const byInvoiceKey = (a: { invoiceKey: string }, b: { invoiceKey: string }): number =>
  a.invoiceKey < b.invoiceKey ? -1 : a.invoiceKey > b.invoiceKey ? 1 : 0

/**
 * Filas de `invoices`, ordenadas por `invoiceKey`. Cada fila toma su entrada en el índice único
 * parcial `invoices_open_invoice_key_key` al insertarse, y un envío simultáneo con la misma clave
 * espera a que esta transacción termine. Si dos envíos traen las mismas facturas en otro orden, cada
 * uno tomaría una y esperaría la del otro: PostgreSQL abortaría a uno por deadlock (503). Con un orden
 * común, el segundo espera en la primera clave compartida y recibe la violación de unicidad (422).
 */
export function toInvoiceRows(request: NewAdvanceRequest): Prisma.InvoiceCreateManyInput[] {
  return [...request.invoices].sort(byInvoiceKey).map((invoice) => ({
    id: invoice.id,
    advanceRequestId: request.id,
    requestStatus: INITIAL_STATUS,
    currency: request.currency,
    issuerRuc: invoice.issuerRuc,
    recipientRuc: invoice.recipientRuc,
    documentType: invoice.documentType,
    seriesNumber: invoice.seriesNumber,
    invoiceKey: invoice.invoiceKey,
    issuerName: invoice.issuerName,
    // Las reglas de shared solo dejan pasar facturas al crédito con neto pendiente.
    paymentTerms: 'CREDIT',
    total: invoice.total,
    netPendingAmount: invoice.netPendingAmount,
    issueDate: isoDateToDb(invoice.issueDate),
    dueDate: isoDateToDb(invoice.dueDate),
    detraction:
      invoice.detraction === null
        ? Prisma.DbNull
        : { percent: invoice.detraction.percent, amount: invoice.detraction.amount },
    signed: invoice.signed,
    xmlFileId: invoice.xmlFileId,
    pdfFileId: invoice.pdfFileId,
  }))
}

export function toInstallmentRows(
  request: NewAdvanceRequest,
): Prisma.InvoiceInstallmentCreateManyInput[] {
  return request.invoices.flatMap((invoice) =>
    invoice.installments.map((installment) => ({
      invoiceId: invoice.id,
      number: installment.number,
      label: installment.label,
      amount: installment.amount,
      dueDate: isoDateToDb(installment.dueDate),
    })),
  )
}

export function toConsentRows(request: NewAdvanceRequest): Prisma.ConsentCreateManyInput[] {
  return request.consents.map((consent) => ({
    advanceRequestId: request.id,
    type: consent.type,
    documentVersion: consent.documentVersion,
    ip: consent.ip,
    userAgent: consent.userAgent,
    acceptedAt: consent.acceptedAt,
  }))
}
