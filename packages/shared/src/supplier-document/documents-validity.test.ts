import { describe, expect, it } from 'vitest'
import {
  type DocumentRequirements,
  type DocumentsValidityInput,
  documentsValid,
  evaluateDocumentsValidity,
  type SupplierDocumentRecord,
} from './documents-validity.js'

const requirements: DocumentRequirements = {
  perSupplier: ['MASTER_AGREEMENT'],
  perRepresentative: ['REPRESENTATIVE_ID', 'POWER_OF_ATTORNEY_CERTIFICATE'],
}

const doc = (
  type: SupplierDocumentRecord['type'],
  representativeId: string | null,
  overrides: Partial<SupplierDocumentRecord> = {},
): SupplierDocumentRecord => ({
  type,
  status: 'APPROVED',
  validUntil: type === 'MASTER_AGREEMENT' ? null : '2026-12-31',
  representativeId,
  ...overrides,
})

const complete: DocumentsValidityInput = {
  documents: [
    doc('MASTER_AGREEMENT', null),
    doc('REPRESENTATIVE_ID', 'rep-1'),
    doc('POWER_OF_ATTORNEY_CERTIFICATE', 'rep-1'),
  ],
  representatives: [{ id: 'rep-1', active: true }],
  today: '2026-09-23',
  requirements,
}

describe('evaluateDocumentsValidity', () => {
  it('todo vigente: válido y sin faltantes', () => {
    expect(evaluateDocumentsValidity(complete)).toEqual({ valid: true, missing: [] })
    expect(documentsValid(complete)).toBe(true)
  })

  it('vigencia de poder vencida: falta la del representante', () => {
    const input = {
      ...complete,
      documents: [
        doc('MASTER_AGREEMENT', null),
        doc('REPRESENTATIVE_ID', 'rep-1'),
        doc('POWER_OF_ATTORNEY_CERTIFICATE', 'rep-1', { validUntil: '2026-09-22' }),
      ],
    }
    expect(evaluateDocumentsValidity(input)).toEqual({
      valid: false,
      missing: [{ type: 'POWER_OF_ATTORNEY_CERTIFICATE', representativeId: 'rep-1' }],
    })
    expect(documentsValid(input)).toBe(false)
  })

  it('los documentos de un representante inactivo no cuentan', () => {
    const input = {
      ...complete,
      representatives: [
        { id: 'rep-1', active: false },
        { id: 'rep-2', active: true },
      ],
    }
    expect(evaluateDocumentsValidity(input)).toEqual({
      valid: false,
      missing: [
        { type: 'REPRESENTATIVE_ID', representativeId: 'rep-2' },
        { type: 'POWER_OF_ATTORNEY_CERTIFICATE', representativeId: 'rep-2' },
      ],
    })
  })

  it('sin representantes activos: faltan los documentos por representante, sin representante', () => {
    for (const representatives of [[], [{ id: 'rep-1', active: false }]]) {
      expect(evaluateDocumentsValidity({ ...complete, representatives })).toEqual({
        valid: false,
        missing: [
          { type: 'REPRESENTATIVE_ID', representativeId: null },
          { type: 'POWER_OF_ATTORNEY_CERTIFICATE', representativeId: null },
        ],
      })
    }
  })

  it('contrato marco ausente: falta a nivel de la empresa', () => {
    const input = {
      ...complete,
      documents: complete.documents.filter((d) => d.type !== 'MASTER_AGREEMENT'),
    }
    expect(evaluateDocumentsValidity(input)).toEqual({
      valid: false,
      missing: [{ type: 'MASTER_AGREEMENT', representativeId: null }],
    })
  })

  it('un documento RECHAZADO o pendiente de revisión no cuenta', () => {
    for (const status of ['REJECTED', 'PENDING_REVIEW'] as const) {
      const input = {
        ...complete,
        documents: [
          doc('MASTER_AGREEMENT', null, { status }),
          doc('REPRESENTATIVE_ID', 'rep-1'),
          doc('POWER_OF_ATTORNEY_CERTIFICATE', 'rep-1'),
        ],
      }
      expect(evaluateDocumentsValidity(input).missing, status).toEqual([
        { type: 'MASTER_AGREEMENT', representativeId: null },
      ])
    }
  })

  it('basta un representante activo completo, aunque otro no lo esté', () => {
    const input = {
      ...complete,
      representatives: [
        { id: 'rep-2', active: true },
        { id: 'rep-1', active: true },
      ],
    }
    expect(evaluateDocumentsValidity(input)).toEqual({ valid: true, missing: [] })
  })

  it('si ningún representante cumple, lista lo que le falta al más cercano a cumplir', () => {
    const input = {
      ...complete,
      documents: [doc('MASTER_AGREEMENT', null), doc('REPRESENTATIVE_ID', 'rep-2')],
      representatives: [
        { id: 'rep-1', active: true },
        { id: 'rep-2', active: true },
        { id: 'rep-3', active: true },
      ],
    }
    expect(evaluateDocumentsValidity(input).missing).toEqual([
      { type: 'POWER_OF_ATTORNEY_CERTIFICATE', representativeId: 'rep-2' },
    ])
  })

  it('un documento de otro representante no cubre al representante evaluado', () => {
    const input = {
      ...complete,
      documents: [
        doc('MASTER_AGREEMENT', null),
        doc('REPRESENTATIVE_ID', 'rep-1'),
        doc('POWER_OF_ATTORNEY_CERTIFICATE', 'rep-2'),
      ],
      representatives: [
        { id: 'rep-1', active: true },
        { id: 'rep-2', active: false },
      ],
    }
    expect(evaluateDocumentsValidity(input).missing).toEqual([
      { type: 'POWER_OF_ATTORNEY_CERTIFICATE', representativeId: 'rep-1' },
    ])
  })

  it('sin requisitos por representante no exige representantes; los repetidos cuentan una vez', () => {
    expect(
      evaluateDocumentsValidity({
        ...complete,
        representatives: [],
        requirements: {
          perSupplier: ['MASTER_AGREEMENT', 'MASTER_AGREEMENT'],
          perRepresentative: [],
        },
      }),
    ).toEqual({ valid: true, missing: [] })
    expect(
      evaluateDocumentsValidity({
        ...complete,
        documents: [],
        representatives: [],
        requirements: {
          perSupplier: ['MASTER_AGREEMENT', 'MASTER_AGREEMENT'],
          perRepresentative: ['REPRESENTATIVE_ID', 'REPRESENTATIVE_ID'],
        },
      }).missing,
    ).toEqual([
      { type: 'MASTER_AGREEMENT', representativeId: null },
      { type: 'REPRESENTATIVE_ID', representativeId: null },
    ])
  })
})
