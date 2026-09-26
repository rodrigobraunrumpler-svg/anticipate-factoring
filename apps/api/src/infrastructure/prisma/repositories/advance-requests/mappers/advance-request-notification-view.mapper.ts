import { decimalToAmount } from '#/infrastructure/prisma/db-values.js'
import type { Prisma } from '#/infrastructure/prisma/generated/client.js'
import type { AdvanceRequestNotificationView } from '#/modules/advance-requests/index.js'

/** Columnas que leen los dos correos: nada más sale de la base. */
export const ADVANCE_REQUEST_NOTIFICATION_SELECT = {
  id: true,
  publicCode: true,
  supplierLegalName: true,
  supplierRuc: true,
  contactFullName: true,
  contactEmail: true,
  requestedAmount: true,
  currency: true,
  invoiceCount: true,
  createdAt: true,
  payer: { select: { shortName: true } },
} satisfies Prisma.AdvanceRequestSelect

export type AdvanceRequestNotificationRow = Prisma.AdvanceRequestGetPayload<{
  select: typeof ADVANCE_REQUEST_NOTIFICATION_SELECT
}>

export function toAdvanceRequestNotificationView(
  row: AdvanceRequestNotificationRow,
): AdvanceRequestNotificationView {
  return {
    id: row.id,
    publicCode: row.publicCode,
    payerShortName: row.payer.shortName,
    supplierLegalName: row.supplierLegalName,
    supplierRuc: row.supplierRuc,
    contactFullName: row.contactFullName,
    contactEmail: row.contactEmail,
    requestedAmount: decimalToAmount(row.requestedAmount),
    currency: row.currency,
    invoiceCount: row.invoiceCount,
    createdAt: row.createdAt,
  }
}
