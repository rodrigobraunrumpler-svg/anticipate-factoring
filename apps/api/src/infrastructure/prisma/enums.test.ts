import {
  ADVANCE_REQUEST_STATUSES,
  CAVALI_REGISTRATION,
  CLOSE_REASONS,
  CONTACT_TIME_SLOTS,
} from '@anticipate/shared/advance-request'
import { PAYMENT_TERMS } from '@anticipate/shared/invoice'
import { CURRENCIES } from '@anticipate/shared/money'
import {
  SUPPLIER_DOCUMENT_STATUSES,
  SUPPLIER_DOCUMENT_TYPES,
} from '@anticipate/shared/supplier-document'
import { ROLES } from '@anticipate/shared/user'
import { describe, expect, it } from 'vitest'
import * as Enums from './generated/enums.js'

const values = (prismaEnum: Record<string, string>) => Object.values(prismaEnum)

describe('los enums de la base coinciden con shared, en el mismo orden', () => {
  it.each([
    ['AdvanceRequestStatus', Enums.AdvanceRequestStatus, ADVANCE_REQUEST_STATUSES],
    ['CloseReason', Enums.CloseReason, CLOSE_REASONS],
    ['Currency', Enums.Currency, CURRENCIES],
    ['PaymentTerms', Enums.PaymentTerms, PAYMENT_TERMS],
    ['CavaliRegistration', Enums.CavaliRegistration, CAVALI_REGISTRATION],
    ['ContactTimeSlot', Enums.ContactTimeSlot, CONTACT_TIME_SLOTS],
    ['SupplierDocumentType', Enums.SupplierDocumentType, SUPPLIER_DOCUMENT_TYPES],
    ['SupplierDocumentStatus', Enums.SupplierDocumentStatus, SUPPLIER_DOCUMENT_STATUSES],
    ['Role', Enums.Role, ROLES],
  ] as const)('%s', (_name, prismaEnum, sharedList) => {
    expect(values(prismaEnum)).toEqual([...sharedList])
  })
})

describe('los enums que solo existen en la base tienen los valores que usa el SQL escrito a mano', () => {
  it.each([
    ['ConsentType', Enums.ConsentType, ['TERMS', 'PERSONAL_DATA']],
    ['FollowUpChannel', Enums.FollowUpChannel, ['CALL', 'WHATSAPP', 'EMAIL', 'OTHER']],
    ['OutboxStatus', Enums.OutboxStatus, ['PENDING', 'PROCESSING', 'PUBLISHED', 'DEAD_LETTER']],
    [
      'StoredFilePurpose',
      Enums.StoredFilePurpose,
      ['INVOICE_XML', 'INVOICE_PDF', 'SUPPLIER_DOCUMENT'],
    ],
    ['StoredFileStatus', Enums.StoredFileStatus, ['PENDING', 'ATTACHED', 'DELETED']],
  ] as const)('%s', (_name, prismaEnum, expected) => {
    expect(values(prismaEnum)).toEqual([...expected])
  })
})
