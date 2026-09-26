import type { Amount, Currency } from '@anticipate/shared/money'

/** Lo que necesitan los dos correos de una solicitud recién creada, leído al momento de enviar. */
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

export interface AdvanceRequestNotificationReaderPort {
  /** La vista de la solicitud, o `null` si no existe. */
  findById(id: string): Promise<AdvanceRequestNotificationView | null>
}

export const ADVANCE_REQUEST_NOTIFICATION_READER = Symbol('ADVANCE_REQUEST_NOTIFICATION_READER')
