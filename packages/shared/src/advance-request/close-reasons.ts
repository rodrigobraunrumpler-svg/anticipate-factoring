import { z } from 'zod'

export const CLOSE_REASONS = [
  'NO_RESPONSE',
  'SPAM_OR_INVALID',
  'SUPPLIER_WITHDREW',
  'INVALID_DOCUMENTS',
  'INVOICE_NOT_ELIGIBLE',
  'UNACCEPTABLE_RISK',
  'OTHER',
] as const
export type CloseReason = (typeof CLOSE_REASONS)[number]
export const closeReasonSchema = z.enum(CLOSE_REASONS)

export const CLOSE_REASON_LABELS: Record<CloseReason, string> = {
  NO_RESPONSE: 'El proveedor no respondió',
  SPAM_OR_INVALID: 'Solicitud de prueba, spam o inválida',
  SUPPLIER_WITHDREW: 'El proveedor decidió no continuar',
  INVALID_DOCUMENTS: 'Documentos incompletos o inválidos',
  INVOICE_NOT_ELIGIBLE: 'La factura no cumple los requisitos',
  UNACCEPTABLE_RISK: 'Riesgo no aceptable',
  OTHER: 'Otro motivo (ver detalle)',
}

/** Qué motivos tienen sentido para cada estado de cierre. */
export const CLOSE_REASONS_BY_STATUS = {
  REJECTED: [
    'INVALID_DOCUMENTS',
    'INVOICE_NOT_ELIGIBLE',
    'UNACCEPTABLE_RISK',
    'SPAM_OR_INVALID',
    'OTHER',
  ],
  WITHDRAWN: ['NO_RESPONSE', 'SUPPLIER_WITHDREW', 'SPAM_OR_INVALID', 'OTHER'],
} as const satisfies Record<'REJECTED' | 'WITHDRAWN', readonly CloseReason[]>
