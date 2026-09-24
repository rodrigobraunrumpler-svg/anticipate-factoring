import { z } from 'zod'
import { VALIDATION_MESSAGES_ES } from '../errors/index.js'

/** Roles del admin, de menor a mayor. Agregar uno = agregarlo aquí en su posición. */
export const ROLES = ['AGENT', 'ADMIN'] as const
export type Role = (typeof ROLES)[number]
export const roleSchema = z.enum(ROLES, { error: VALIDATION_MESSAGES_ES.user.role })

export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  AGENT: 'Gestor',
  ADMIN: 'Administrador',
}

export function hasRoleAtLeast(role: Role, minimum: Role): boolean {
  return ROLES.indexOf(role) >= ROLES.indexOf(minimum)
}
