import { z } from 'zod'

/** Roles del admin, de menor a mayor. Agregar uno = agregarlo aquí en su posición. */
export const ROLES = ['AGENT', 'ADMIN'] as const
export type Role = (typeof ROLES)[number]
export const roleSchema = z.enum(ROLES)

export const ROLE_LABELS: Record<Role, string> = { AGENT: 'Gestor', ADMIN: 'Administrador' }

export function hasRoleAtLeast(role: Role, minimum: Role): boolean {
  return ROLES.indexOf(role) >= ROLES.indexOf(minimum)
}
