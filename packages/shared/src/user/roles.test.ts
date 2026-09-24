import { describe, expect, it } from 'vitest'
import { hasRoleAtLeast } from './roles.js'

describe('hasRoleAtLeast', () => {
  it('ADMIN alcanza todo; AGENT solo AGENT', () => {
    expect(hasRoleAtLeast('ADMIN', 'ADMIN')).toBe(true)
    expect(hasRoleAtLeast('ADMIN', 'AGENT')).toBe(true)
    expect(hasRoleAtLeast('AGENT', 'AGENT')).toBe(true)
    expect(hasRoleAtLeast('AGENT', 'ADMIN')).toBe(false)
  })
})
