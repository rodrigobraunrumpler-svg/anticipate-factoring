import { dbDateToIso, decimalToAmount } from '#/infrastructure/prisma/db-values.js'
import type { Prisma } from '#/infrastructure/prisma/generated/client.js'
import type {
  AdvanceRequestNotificationView,
  TeamAlertNotificationView,
} from '#/modules/advance-requests/index.js'

/** Columnas que lee la confirmación al proveedor: nada más sale de la base. */
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

/**
 * Columnas que lee el aviso al equipo: las de la confirmación, el resto del contacto, el
 * representante ligado, el motivo, Cavali y, por factura, la serie, el neto pendiente, el último
 * vencimiento y el resumen de las cuotas (cuántas y la primera), sin leer cada cuota.
 */
export const TEAM_ALERT_NOTIFICATION_SELECT = {
  ...ADVANCE_REQUEST_NOTIFICATION_SELECT,
  contactMobile: true,
  contactTimeSlot: true,
  isLegalRepresentative: true,
  contactJobTitle: true,
  purpose: true,
  cavaliRegistration: true,
  legalRepresentative: { select: { fullName: true, jobTitle: true } },
  invoices: {
    // UUIDv7: el orden de los ids es el orden en que llegaron los XML.
    orderBy: { id: 'asc' },
    select: {
      seriesNumber: true,
      netPendingAmount: true,
      dueDate: true,
      _count: { select: { installments: true } },
      installments: {
        orderBy: [{ dueDate: 'asc' }, { number: 'asc' }],
        take: 1,
        select: { dueDate: true },
      },
    },
  },
} satisfies Prisma.AdvanceRequestSelect

export type AdvanceRequestNotificationRow = Prisma.AdvanceRequestGetPayload<{
  select: typeof ADVANCE_REQUEST_NOTIFICATION_SELECT
}>

export type TeamAlertNotificationRow = Prisma.AdvanceRequestGetPayload<{
  select: typeof TEAM_ALERT_NOTIFICATION_SELECT
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

export function toTeamAlertNotificationView(
  row: TeamAlertNotificationRow,
): TeamAlertNotificationView {
  return {
    ...toAdvanceRequestNotificationView(row),
    contactMobile: row.contactMobile,
    contactTimeSlot: row.contactTimeSlot,
    isLegalRepresentative: row.isLegalRepresentative,
    contactJobTitle: row.contactJobTitle,
    legalRepresentative:
      row.legalRepresentative === null
        ? null
        : {
            fullName: row.legalRepresentative.fullName,
            jobTitle: row.legalRepresentative.jobTitle,
          },
    purpose: row.purpose,
    cavaliRegistration: row.cavaliRegistration,
    invoices: row.invoices.map((invoice) => {
      const [first] = invoice.installments
      return {
        seriesNumber: invoice.seriesNumber,
        netPendingAmount: decimalToAmount(invoice.netPendingAmount),
        dueDate: dbDateToIso(invoice.dueDate),
        installmentCount: invoice._count.installments,
        firstDueDate: first === undefined ? null : dbDateToIso(first.dueDate),
      }
    }),
  }
}
