import { API_ERROR_MESSAGES_ES, type ValidationViolation } from '@anticipate/shared/api'
import { ApplicationError } from './application-error.js'

/** Campo con que se informa una observación sobre el valor completo (un issue sin ruta). */
export const VALIDATION_ROOT_FIELD = '$'
/** Tope de campos por respuesta: un cuerpo hostil no puede multiplicar el tamaño de la respuesta. */
export const MAX_VALIDATION_VIOLATIONS = 50
/** Tope de mensajes por campo. */
export const MAX_MESSAGES_PER_FIELD = 10

const MAX_FIELD_LENGTH = 256
const MAX_MESSAGE_LENGTH = 1000

export type ApiValidationErrorDetails = { readonly violations: readonly ValidationViolation[] }

/** Lo que acepta la normalización: cualquier cosa; lo inválido se corrige en vez de lanzar. */
export type ValidationViolationInput = {
  readonly field?: unknown
  readonly messages?: unknown
}

function normalizeField(field: unknown): string {
  if (typeof field !== 'string') return VALIDATION_ROOT_FIELD
  const trimmed = field.trim()
  return trimmed === '' ? VALIDATION_ROOT_FIELD : trimmed.slice(0, MAX_FIELD_LENGTH)
}

function normalizeMessages(messages: unknown): string[] {
  if (!Array.isArray(messages)) return []
  return messages
    .filter((message): message is string => typeof message === 'string' && message.trim() !== '')
    .map((message) => message.trim().slice(0, MAX_MESSAGE_LENGTH))
}

/**
 * Agrupa por campo en el orden en que aparecen, quita mensajes repetidos, acota tamaños y nunca
 * lanza: un campo inválido o vacío pasa a `VALIDATION_ROOT_FIELD`, un campo sin mensajes válidos
 * recibe el mensaje genérico y una lista vacía produce una sola observación genérica.
 */
export function normalizeViolations(
  violations: readonly ValidationViolationInput[],
): ValidationViolation[] {
  const grouped = new Map<string, string[]>()
  for (const violation of Array.isArray(violations) ? violations : []) {
    const candidate: ValidationViolationInput =
      typeof violation === 'object' && violation !== null ? violation : {}
    const field = normalizeField(candidate.field)
    let messages = grouped.get(field)
    if (messages === undefined) {
      if (grouped.size >= MAX_VALIDATION_VIOLATIONS) continue
      messages = []
      grouped.set(field, messages)
    }
    for (const message of normalizeMessages(candidate.messages)) {
      if (messages.length < MAX_MESSAGES_PER_FIELD && !messages.includes(message)) {
        messages.push(message)
      }
    }
  }
  if (grouped.size === 0) grouped.set(VALIDATION_ROOT_FIELD, [])
  return [...grouped].map(([field, messages]) => ({
    field,
    messages: messages.length > 0 ? messages : [API_ERROR_MESSAGES_ES.VALIDATION_ERROR],
  }))
}

/** 400 `VALIDATION_ERROR` con `details.violations`. Nunca lanza: lo recibido se normaliza. */
export class ApiValidationError extends ApplicationError<
  'VALIDATION_ERROR',
  ApiValidationErrorDetails
> {
  constructor(violations: readonly ValidationViolationInput[], diagnostic?: string) {
    super('VALIDATION_ERROR', {
      details: { violations: normalizeViolations(violations) },
      diagnostic,
    })
  }

  get violations(): readonly ValidationViolation[] {
    return this.publicDetails?.violations ?? []
  }
}
