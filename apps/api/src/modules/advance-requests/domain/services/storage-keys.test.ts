import { describe, expect, it } from 'vitest'
import { storageKeys } from './storage-keys.js'

const payerId = '0199a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b'
const requestId = '0199a3b4-c5d7-7a11-8b22-3c4d5e6f7a8b'
const invoiceId = '0199a3b4-c5d8-7b33-9c44-5d6e7f8a9b0c'

describe('storageKeys', () => {
  it('arma las rutas de las facturas con ids', () => {
    expect(storageKeys.invoiceXml(payerId, requestId, invoiceId)).toBe(
      `payers/${payerId}/advance-requests/${requestId}/invoices/${invoiceId}.xml`,
    )
    expect(storageKeys.invoicePdf(payerId, requestId, invoiceId)).toBe(
      `payers/${payerId}/advance-requests/${requestId}/invoices/${invoiceId}.pdf`,
    )
  })

  it('escribe los ids en minúsculas: un mismo id siempre da la misma clave', () => {
    expect(storageKeys.invoiceXml(payerId.toUpperCase(), requestId, invoiceId)).toBe(
      storageKeys.invoiceXml(payerId, requestId, invoiceId),
    )
  })

  it.each([
    ['../../etc'],
    [''],
    [`${payerId}/..`],
    ['0199a3b4-c5d6-0e8f-9a0b-1c2d3e4f5a6b'],
    ['0199a3b4-c5d6-7e8f-1a0b-1c2d3e4f5a6b'],
  ])('rechaza un segmento que no es un UUID (%s)', (bad) => {
    expect(() => storageKeys.invoiceXml(bad, requestId, invoiceId)).toThrow(RangeError)
    expect(() => storageKeys.invoicePdf(payerId, bad, invoiceId)).toThrow(RangeError)
    expect(() => storageKeys.invoicePdf(payerId, requestId, bad)).toThrow(RangeError)
  })
})
