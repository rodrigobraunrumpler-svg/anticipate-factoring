import type { CavaliRegistration, ContactTimeSlot } from '@anticipate/shared/advance-request'
import type { IsoDate } from '@anticipate/shared/dates'
import type { Amount, Currency } from '@anticipate/shared/money'

/**
 * Lo que necesita la confirmación al proveedor de una solicitud recién creada, leído al momento de
 * enviar (el payload del outbox no lleva datos personales).
 */
export type AdvanceRequestNotificationView = {
  id: string
  publicCode: string
  payerShortName: string
  /** Razón social tal como la escribió el proveedor en el formulario. */
  supplierLegalName: string
  supplierRuc: string
  contactFullName: string
  contactEmail: string
  requestedAmount: Amount
  currency: Currency
  invoiceCount: number
  createdAt: Date
}

/** Una factura de la solicitud, con el resumen de sus cuotas. */
export type TeamAlertInvoice = {
  seriesNumber: string
  netPendingAmount: Amount
  /** Vencimiento de la última cuota. */
  dueDate: IsoDate
  installmentCount: number
  /** Vencimiento de la primera cuota; `null` si la factura no tiene cuotas guardadas. */
  firstDueDate: IsoDate | null
}

/**
 * Lo que necesita el aviso al equipo para contactar al proveedor sin abrir otra herramienta: el
 * contacto completo, el representante legal ligado a la solicitud (si el contacto declaró serlo), el
 * motivo, Cavali y las facturas. Solo estas columnas salen de la base.
 */
export type TeamAlertNotificationView = AdvanceRequestNotificationView & {
  contactMobile: string
  contactTimeSlot: ContactTimeSlot
  isLegalRepresentative: boolean
  contactJobTitle: string | null
  /** El representante registrado del proveedor, tal como quedó guardado (mismo DNI que el contacto). */
  legalRepresentative: { fullName: string; jobTitle: string | null } | null
  purpose: string | null
  cavaliRegistration: CavaliRegistration
  /** En el orden en que llegaron. */
  invoices: readonly TeamAlertInvoice[]
}

export interface AdvanceRequestNotificationReaderPort {
  /** La vista de la confirmación al proveedor, o `null` si la solicitud no existe. */
  findById(id: string): Promise<AdvanceRequestNotificationView | null>
  /** La vista del aviso al equipo, o `null` si la solicitud no existe. */
  findTeamAlertById(id: string): Promise<TeamAlertNotificationView | null>
}

export const ADVANCE_REQUEST_NOTIFICATION_READER = Symbol('ADVANCE_REQUEST_NOTIFICATION_READER')
