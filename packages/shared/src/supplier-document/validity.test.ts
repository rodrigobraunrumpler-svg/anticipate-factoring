import { describe, expect, it } from 'vitest'
import { VALIDATION_MESSAGES_ES } from '../errors/index.js'
import {
  computeValidUntil,
  displayStatus,
  isCurrentlyValid,
  requiresValidity,
  SUPPLIER_DOCUMENT_DISPLAY_STATUSES,
  SUPPLIER_DOCUMENT_STATUS_LABELS,
  SUPPLIER_DOCUMENT_STATUSES,
  SUPPLIER_DOCUMENT_TYPE_LABELS,
  SUPPLIER_DOCUMENT_TYPES,
  supplierDocumentStatusSchema,
  supplierDocumentTypeSchema,
  type ValidityRules,
} from './validity.js'

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

describe('displayStatus', () => {
  it('un documento aprobado cuya vigencia ya pasó se muestra como vencido', () => {
    expect(displayStatus({ status: 'APPROVED', validUntil: '2026-09-22' }, '2026-09-23')).toBe(
      'EXPIRED',
    )
    expect(displayStatus({ status: 'APPROVED', validUntil: '2026-09-23' }, '2026-09-23')).toBe(
      'APPROVED',
    )
    expect(displayStatus({ status: 'APPROVED', validUntil: null }, '2026-09-23')).toBe('APPROVED')
  })

  it('los estados que no son aprobados se muestran tal cual, aunque su fecha haya pasado', () => {
    expect(displayStatus({ status: 'REJECTED', validUntil: '2020-01-01' }, '2026-09-23')).toBe(
      'REJECTED',
    )
    expect(
      displayStatus({ status: 'PENDING_REVIEW', validUntil: '2020-01-01' }, '2026-09-23'),
    ).toBe('PENDING_REVIEW')
  })

  it('todo estado para mostrar tiene etiqueta en español, y las tablas son de solo lectura', () => {
    expect([...SUPPLIER_DOCUMENT_DISPLAY_STATUSES]).toEqual([
      ...SUPPLIER_DOCUMENT_STATUSES,
      'EXPIRED',
    ])
    for (const status of SUPPLIER_DOCUMENT_DISPLAY_STATUSES)
      expect(SUPPLIER_DOCUMENT_STATUS_LABELS[status]).toBeTruthy()
    expect(SUPPLIER_DOCUMENT_STATUS_LABELS.EXPIRED).toBe('Vencido')
    const mutate = () => {
      // @ts-expect-error la tabla es de solo lectura
      SUPPLIER_DOCUMENT_STATUS_LABELS.EXPIRED = 'x'
      // @ts-expect-error la tabla es de solo lectura
      SUPPLIER_DOCUMENT_TYPE_LABELS.OTHER = 'x'
    }
    expect(mutate).toBeTypeOf('function')
  })
})

describe('requiresValidity', () => {
  it('solo el DNI y la vigencia de poder vencen', () => {
    expect(SUPPLIER_DOCUMENT_TYPES.filter(requiresValidity)).toEqual([
      'REPRESENTATIVE_ID',
      'POWER_OF_ATTORNEY_CERTIFICATE',
    ])
  })
})

describe('esquemas de tipo y estado de documento', () => {
  it('rechazan valores desconocidos con mensaje en español', () => {
    const type = supplierDocumentTypeSchema.safeParse('PASAPORTE')
    expect(!type.success && type.error.issues[0]?.message).toBe(
      VALIDATION_MESSAGES_ES.supplierDocument.type,
    )
    const status = supplierDocumentStatusSchema.safeParse('EXPIRED')
    expect(!status.success && status.error.issues[0]?.message).toBe(
      VALIDATION_MESSAGES_ES.supplierDocument.status,
    )
  })
})
