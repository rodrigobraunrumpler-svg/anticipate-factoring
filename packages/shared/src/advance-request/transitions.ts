import { z } from 'zod'
import {
  createProblem,
  MESSAGES_ES,
  type Problem,
  VALIDATION_MESSAGES_ES,
} from '../errors/index.js'
import { hasRoleAtLeast, type Role } from '../user/index.js'
import { CLOSE_REASONS_BY_STATUS, type CloseReason, closeReasonSchema } from './close-reasons.js'
import { type AdvanceRequestStatus, advanceRequestStatusSchema } from './statuses.js'

/** Nombres de guardas. La API las implementa (necesitan base de datos); shared solo las nombra. */
export const GUARDS = ['documentsValid', 'quoteAccepted'] as const
export type Guard = (typeof GUARDS)[number]

export type Transition = {
  from: AdvanceRequestStatus
  to: AdvanceRequestStatus
  guard?: Guard
  minRole?: Role
  requiresReason?: true
}

/** Única fuente de verdad de la máquina de estados (STACK §9). El admin pinta botones con esto; la API lo hace cumplir. */
export const TRANSITIONS: readonly Readonly<Transition>[] = [
  { from: 'NEW', to: 'CONTACTED' },
  { from: 'NEW', to: 'NO_ANSWER' },
  { from: 'NEW', to: 'WITHDRAWN', requiresReason: true },
  { from: 'NO_ANSWER', to: 'CONTACTED' },
  { from: 'NO_ANSWER', to: 'WITHDRAWN', requiresReason: true },
  { from: 'CONTACTED', to: 'DOCUMENTS_PENDING' },
  { from: 'CONTACTED', to: 'WITHDRAWN', requiresReason: true },
  { from: 'DOCUMENTS_PENDING', to: 'UNDER_REVIEW', guard: 'documentsValid' },
  { from: 'DOCUMENTS_PENDING', to: 'REJECTED', requiresReason: true },
  { from: 'DOCUMENTS_PENDING', to: 'WITHDRAWN', requiresReason: true },
  { from: 'UNDER_REVIEW', to: 'QUOTE_SENT' },
  { from: 'UNDER_REVIEW', to: 'REJECTED', requiresReason: true },
  { from: 'UNDER_REVIEW', to: 'WITHDRAWN', requiresReason: true },
  { from: 'QUOTE_SENT', to: 'APPROVED', guard: 'quoteAccepted' },
  { from: 'QUOTE_SENT', to: 'WITHDRAWN', requiresReason: true },
  { from: 'APPROVED', to: 'DISBURSED', minRole: 'ADMIN' },
  { from: 'APPROVED', to: 'WITHDRAWN', requiresReason: true },
]

export function transitionsFrom(from: AdvanceRequestStatus, role: Role): Readonly<Transition>[] {
  return TRANSITIONS.filter((t) => t.from === from && hasRoleAtLeast(role, t.minRole ?? 'AGENT'))
}

/** Hechos que la API calcula con la base de datos para resolver las guardas. */
export type Facts = Partial<Record<Guard, boolean>>

/** Lo que el usuario puede hacer ahora mismo: filtra por rol y por guardas ya resueltas. La API lo devuelve como `allowedActions`. */
export function availableTransitions(
  from: AdvanceRequestStatus,
  role: Role,
  facts: Facts,
): Readonly<Transition>[] {
  return transitionsFrom(from, role).filter((t) => t.guard === undefined || facts[t.guard] === true)
}

export type StatusChange = {
  from: AdvanceRequestStatus
  to: AdvanceRequestStatus
  role: Role
  closeReason?: CloseReason
  /** Texto libre del motivo. Obligatorio cuando `closeReason` es `OTHER`. */
  closeReasonDetail?: string
}

export type StatusChangeResult =
  | { ok: true; guard: Guard | null; requiresReason: boolean }
  | { ok: false; problem: Problem }

const reject = (
  code:
    | 'TRANSITION_NOT_ALLOWED'
    | 'INSUFFICIENT_ROLE'
    | 'CLOSE_REASON_REQUIRED'
    | 'CLOSE_REASON_NOT_VALID'
    | 'CLOSE_REASON_NOT_APPLICABLE'
    | 'CLOSE_REASON_DETAIL_REQUIRED',
  field?: 'closeReason' | 'closeReasonDetail',
): StatusChangeResult => ({
  ok: false,
  problem: createProblem(code, field === undefined ? {} : { field }),
})

const hasText = (value: string | undefined): boolean => (value?.trim() ?? '') !== ''

/**
 * Evaluación pura. Si devuelve `guard`, la API debe comprobarla contra la base de datos antes de
 * aplicar el cambio. Si falla, devuelve un `Problem` con código estable y mensaje en español.
 */
export function evaluateStatusChange(change: StatusChange): StatusChangeResult {
  const t = TRANSITIONS.find((x) => x.from === change.from && x.to === change.to)
  if (!t) return reject('TRANSITION_NOT_ALLOWED')
  if (!hasRoleAtLeast(change.role, t.minRole ?? 'AGENT')) return reject('INSUFFICIENT_ROLE')
  const requiresReason = t.requiresReason === true
  if (!requiresReason) {
    if (change.closeReason !== undefined || hasText(change.closeReasonDetail)) {
      return reject('CLOSE_REASON_NOT_APPLICABLE', 'closeReason')
    }
    return { ok: true, guard: t.guard ?? null, requiresReason }
  }
  if (!change.closeReason) return reject('CLOSE_REASON_REQUIRED', 'closeReason')
  const allowed = CLOSE_REASONS_BY_STATUS[
    t.to as keyof typeof CLOSE_REASONS_BY_STATUS
  ] as readonly CloseReason[]
  if (!allowed.includes(change.closeReason)) return reject('CLOSE_REASON_NOT_VALID', 'closeReason')
  if (change.closeReason === 'OTHER' && !hasText(change.closeReasonDetail)) {
    return reject('CLOSE_REASON_DETAIL_REQUIRED', 'closeReasonDetail')
  }
  return { ok: true, guard: t.guard ?? null, requiresReason }
}

/**
 * Cuerpo de `PATCH /admin/advance-requests/:id/status`. `version` sostiene el bloqueo optimista (D28).
 * Aplica la misma regla de detalle que `evaluateStatusChange`: `OTHER` exige `closeReasonDetail`.
 */
export const statusChangeSchema = z
  .object({
    to: advanceRequestStatusSchema,
    version: z
      .number({ error: VALIDATION_MESSAGES_ES.advanceRequest.version })
      .int({ error: VALIDATION_MESSAGES_ES.advanceRequest.version })
      .nonnegative({ error: VALIDATION_MESSAGES_ES.advanceRequest.version }),
    closeReason: closeReasonSchema.optional(),
    closeReasonDetail: z
      .string({ error: VALIDATION_MESSAGES_ES.advanceRequest.closeReasonDetailMax })
      .trim()
      .max(500, { error: VALIDATION_MESSAGES_ES.advanceRequest.closeReasonDetailMax })
      .optional(),
  })
  .superRefine((body, ctx) => {
    if (body.closeReason === 'OTHER' && !hasText(body.closeReasonDetail)) {
      ctx.addIssue({
        code: 'custom',
        path: ['closeReasonDetail'],
        message: MESSAGES_ES.CLOSE_REASON_DETAIL_REQUIRED,
      })
    }
  })
export type StatusChangeDto = z.infer<typeof statusChangeSchema>
