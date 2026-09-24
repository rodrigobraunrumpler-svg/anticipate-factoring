import { describe, expect, it } from 'vitest'
import { computeValidUntil, isCurrentlyValid, type ValidityRules } from './validity.js'

const rules: ValidityRules = { powerOfAttorneyValidityDays: 90 }

describe('computeValidUntil', () => {
  it('vigencia de poder: fecha de emisión más los días del contexto', () => {
    expect(
      computeValidUntil('POWER_OF_ATTORNEY_CERTIFICATE', { issuedOn: '2026-09-01' }, rules),
    ).toBe('2026-11-30')
    expect(
      computeValidUntil(
        'POWER_OF_ATTORNEY_CERTIFICATE',
        { issuedOn: '2026-09-01' },
        { powerOfAttorneyValidityDays: 30 },
      ),
    ).toBe('2026-10-01')
  })

  it('DNI: hasta su fecha de caducidad', () => {
    expect(computeValidUntil('REPRESENTATIVE_ID', { expiresOn: '2030-05-20' }, rules)).toBe(
      '2030-05-20',
    )
  })

  it('contrato marco y otros: sin vencimiento', () => {
    expect(computeValidUntil('MASTER_AGREEMENT', {}, rules)).toBeNull()
    expect(computeValidUntil('OTHER', {}, rules)).toBeNull()
  })

  it('lanza si falta el dato que el tipo necesita', () => {
    expect(() => computeValidUntil('POWER_OF_ATTORNEY_CERTIFICATE', {}, rules)).toThrow()
    expect(() => computeValidUntil('REPRESENTATIVE_ID', {}, rules)).toThrow()
  })
})

describe('isCurrentlyValid', () => {
  it('solo un documento aprobado y no vencido está vigente', () => {
    expect(isCurrentlyValid({ status: 'APPROVED', validUntil: '2026-12-31' }, '2026-09-23')).toBe(
      true,
    )
    expect(isCurrentlyValid({ status: 'APPROVED', validUntil: '2026-09-23' }, '2026-09-23')).toBe(
      true,
    )
    expect(isCurrentlyValid({ status: 'APPROVED', validUntil: '2026-09-22' }, '2026-09-23')).toBe(
      false,
    )
    expect(isCurrentlyValid({ status: 'APPROVED', validUntil: null }, '2026-09-23')).toBe(true)
    expect(isCurrentlyValid({ status: 'PENDING_REVIEW', validUntil: null }, '2026-09-23')).toBe(
      false,
    )
    expect(isCurrentlyValid({ status: 'REJECTED', validUntil: '2099-01-01' }, '2026-09-23')).toBe(
      false,
    )
  })
})
