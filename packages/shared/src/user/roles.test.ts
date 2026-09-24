import { describe, expect, it } from 'vitest'
import { VALIDATION_MESSAGES_ES } from '../errors/index.js'
import { hasRoleAtLeast, ROLE_LABELS, ROLES, roleSchema } from './roles.js'

describe('hasRoleAtLeast', () => {
  it('ADMIN alcanza todo; AGENT solo AGENT', () => {
    expect(hasRoleAtLeast('ADMIN', 'ADMIN')).toBe(true)
    expect(hasRoleAtLeast('ADMIN', 'AGENT')).toBe(true)
    expect(hasRoleAtLeast('AGENT', 'AGENT')).toBe(true)
    expect(hasRoleAtLeast('AGENT', 'ADMIN')).toBe(false)
  })
})

describe('ROLE_LABELS', () => {
  it('todo rol tiene etiqueta en español y la tabla es de solo lectura', () => {
    for (const role of ROLES) expect(ROLE_LABELS[role]).toBeTruthy()
    const mutate = () => {
      // @ts-expect-error la tabla es de solo lectura
      ROLE_LABELS.ADMIN = 'x'
    }
    expect(mutate).toBeTypeOf('function')
  })
})

describe('roleSchema', () => {
  it('rechaza un rol desconocido con mensaje en español', () => {
    const r = roleSchema.safeParse('OWNER')
    expect(!r.success && r.error.issues[0]?.message).toBe(VALIDATION_MESSAGES_ES.user.role)
  })
})
