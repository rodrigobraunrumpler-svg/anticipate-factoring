import { z } from 'zod'
import { VALIDATION_MESSAGES_ES } from '../errors/index.js'

export const ADVANCE_REQUEST_STATUSES = [
  'NEW',
  'NO_ANSWER',
  'CONTACTED',
  'DOCUMENTS_PENDING',
  'UNDER_REVIEW',
  'QUOTE_SENT',
  'APPROVED',
  'DISBURSED',
  'REJECTED',
  'WITHDRAWN',
] as const
export type AdvanceRequestStatus = (typeof ADVANCE_REQUEST_STATUSES)[number]
export const advanceRequestStatusSchema = z.enum(ADVANCE_REQUEST_STATUSES, {
  error: VALIDATION_MESSAGES_ES.advanceRequest.status,
})

export const INITIAL_STATUS = 'NEW' satisfies AdvanceRequestStatus

export const TERMINAL_STATUSES = [
  'DISBURSED',
  'REJECTED',
  'WITHDRAWN',
] as const satisfies readonly AdvanceRequestStatus[]
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number]

export function isTerminalStatus(status: AdvanceRequestStatus): status is TerminalStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(status)
}

/** Etiquetas en español para la interfaz. */
export const STATUS_LABELS: Readonly<Record<AdvanceRequestStatus, string>> = {
  NEW: 'Nueva',
  NO_ANSWER: 'No contesta',
  CONTACTED: 'Contactado',
  DOCUMENTS_PENDING: 'Documentos pendientes',
  UNDER_REVIEW: 'En evaluación',
  QUOTE_SENT: 'Proforma enviada',
  APPROVED: 'Aprobada',
  DISBURSED: 'Desembolsada',
  REJECTED: 'Rechazada',
  WITHDRAWN: 'Desistida',
}
