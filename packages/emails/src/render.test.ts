import { describe, expect, it } from 'vitest'
import { renderAdvanceRequestConfirmation, renderNewAdvanceRequestAlert } from './render.js'

describe('renderAdvanceRequestConfirmation', () => {
  it('saluda al contacto y muestra el código, el pagador y el monto', async () => {
    const email = await renderAdvanceRequestConfirmation({
      contactName: 'Ana Pérez',
      publicCode: 'ANT-2026-000123',
      payerName: 'SEA',
      requestedAmount: '8000.00',
      currency: 'PEN',
      invoiceCount: 2,
    })
    expect(email.subject).toBe('Recibimos tu solicitud ANT-2026-000123')
    expect(email.html).toMatch(/<html[^>]*\slang="es"/)
    expect(email.html).not.toContain('lang="en"')
    expect(email.html).toContain('Ana Pérez')
    expect(email.html).toContain('ANT-2026-000123')
    expect(email.text).toContain('PEN 8000.00')
    expect(email.text).toContain('2 facturas')
  })

  it('escapa el texto controlado por el usuario', async () => {
    const email = await renderAdvanceRequestConfirmation({
      contactName: '<script>alert(1)</script>',
      publicCode: 'ANT-2026-000001',
      payerName: 'SEA',
      requestedAmount: '1.00',
      currency: 'USD',
      invoiceCount: 1,
    })
    expect(email.html).not.toContain('<script>')
    expect(email.text).toContain('1 factura')
    expect(email.text).not.toContain('1 facturas')
  })
})

describe('renderNewAdvanceRequestAlert', () => {
  it('incluye el enlace al detalle en el admin', async () => {
    const email = await renderNewAdvanceRequestAlert({
      publicCode: 'ANT-2026-000123',
      payerName: 'SEA',
      supplierName: 'PROVEEDOR EJEMPLO S.A.C.',
      supplierRuc: '20100070970',
      requestedAmount: '8000.00',
      currency: 'PEN',
      invoiceCount: 2,
      adminUrl: 'http://localhost:3000/advance-requests/0b4e6c2d',
    })
    expect(email.subject).toBe('Nueva solicitud ANT-2026-000123 · SEA')
    expect(email.html).toContain('href="http://localhost:3000/advance-requests/0b4e6c2d"')
    expect(email.text).toContain('20100070970')
  })
})
