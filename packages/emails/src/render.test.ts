import { describe, expect, it } from 'vitest'
import type { NewAdvanceRequestAlertData } from './new-advance-request-alert.js'
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

const ALERT: NewAdvanceRequestAlertData = {
  publicCode: 'ANT-2026-000123',
  payerName: 'SEA',
  receivedAt: '24/09/2026 10:00',
  company: { legalName: 'PROVEEDOR EJEMPLO S.A.C.', ruc: '20100070970' },
  contact: {
    fullName: 'Ana Pérez',
    mobile: '987 654 321',
    mobileHref: 'tel:+51987654321',
    email: 'ana@proveedor.pe',
    timeSlot: 'Por la mañana (9 a 13 h)',
    role: 'Representante legal',
  },
  legalRepresentative: null,
  requestedAmount: '8000.00',
  currency: 'PEN',
  purpose: 'Capital de trabajo',
  cavaliRegistration: 'No sé',
  invoices: [
    {
      seriesNumber: 'F001-123',
      netPendingAmount: '10620.00',
      due: '2 cuotas: la primera vence el 30/10/2026 y la última el 30/11/2026',
    },
    { seriesNumber: 'F001-124', netPendingAmount: '500.00', due: 'vence el 15/12/2026' },
  ],
  adminUrl: null,
}

describe('renderNewAdvanceRequestAlert', () => {
  it('trae todo lo que el equipo necesita para llamar: contacto, empresa, monto y facturas', async () => {
    const email = await renderNewAdvanceRequestAlert(ALERT)
    expect(email.subject).toBe('Nueva solicitud ANT-2026-000123 · SEA')
    expect(email.html).toMatch(/<html[^>]*\slang="es"/)
    for (const version of [email.html, email.text]) {
      for (const expected of [
        'ANT-2026-000123',
        'SEA',
        '24/09/2026 10:00 (hora de Lima)',
        'PROVEEDOR EJEMPLO S.A.C.',
        '20100070970',
        'Ana Pérez',
        '987 654 321',
        'ana@proveedor.pe',
        'Por la mañana (9 a 13 h)',
        'Representante legal',
        'PEN 8000.00',
        'Capital de trabajo',
        'No sé',
        'F001-123',
        'PEN 10620.00',
        '2 cuotas: la primera vence el 30/10/2026 y la última el 30/11/2026',
        'F001-124',
        'vence el 15/12/2026',
      ]) {
        expect(version).toContain(expected)
      }
    }
    expect(email.text).toContain('Facturas (2)')
    // Celular y correo se abren con un clic; en el texto plano van sin el enlace repetido.
    expect(email.html).toContain('href="tel:+51987654321"')
    expect(email.html).toContain('href="mailto:ana@proveedor.pe"')
    expect(email.text).not.toContain('tel:')
    expect(email.text).not.toContain('mailto:')
  })

  it('sin ADMIN_BASE_URL no enlaza a ningún admin', async () => {
    const email = await renderNewAdvanceRequestAlert(ALERT)
    expect(email.html).not.toContain('admin')
    expect(email.text).not.toMatch(/admin/i)
  })

  it('con ADMIN_BASE_URL enlaza al detalle en el admin, también en el texto plano', async () => {
    const adminUrl = 'https://admin.anticipate.pe/advance-requests/0b4e6c2d'
    const email = await renderNewAdvanceRequestAlert({ ...ALERT, adminUrl })
    expect(email.html).toContain(`href="${adminUrl}"`)
    expect(email.text).toContain(adminUrl)
  })

  it('sin motivo no muestra la línea del motivo', async () => {
    const email = await renderNewAdvanceRequestAlert({ ...ALERT, purpose: null })
    expect(email.text).not.toContain('Motivo')
  })

  it('muestra el representante legal registrado solo cuando se lo pasan', async () => {
    const without = await renderNewAdvanceRequestAlert(ALERT)
    expect(without.text).not.toContain('Representante legal registrado')
    const withRepresentative = await renderNewAdvanceRequestAlert({
      ...ALERT,
      contact: { ...ALERT.contact, role: 'Jefa de finanzas (no es la representante legal)' },
      legalRepresentative: 'Ana María Pérez Gómez (Gerente general)',
    })
    for (const version of [withRepresentative.html, withRepresentative.text]) {
      expect(version).toContain('Representante legal registrado')
      expect(version).toContain('Ana María Pérez Gómez (Gerente general)')
      expect(version).toContain('Jefa de finanzas (no es la representante legal)')
    }
  })

  it('escapa en el HTML todo texto del proveedor y lo deja legible en el texto plano', async () => {
    const hostile = {
      name: `Ana "La Jefa" O'Brien <b>&</b>`,
      company: '<script>alert(1)</script> & Hijos S.A.C.',
      purpose: 'Pago a <proveedores> & "otros"',
      role: 'Jefa <de> finanzas',
      representative: '<img src=x onerror=alert(1)> Pérez',
      email: "o'brien@proveedor.pe",
    }
    const email = await renderNewAdvanceRequestAlert({
      ...ALERT,
      company: { ...ALERT.company, legalName: hostile.company },
      contact: {
        ...ALERT.contact,
        fullName: hostile.name,
        role: hostile.role,
        email: hostile.email,
      },
      legalRepresentative: hostile.representative,
      purpose: hostile.purpose,
    })
    for (const raw of ['<script>', '<b>', '<img', '<proveedores>', '<de>']) {
      expect(email.html).not.toContain(raw)
    }
    for (const escaped of [
      '&lt;script&gt;alert(1)&lt;/script&gt; &amp; Hijos S.A.C.',
      '&lt;b&gt;&amp;&lt;/b&gt;',
      '&lt;proveedores&gt; &amp;',
      '&lt;img src=x onerror=alert(1)&gt;',
      '&quot;La Jefa&quot;',
    ]) {
      expect(email.html).toContain(escaped)
    }
    for (const literal of Object.values(hostile)) expect(email.text).toContain(literal)
    // El asunto no lleva texto del proveedor: solo el código y el pagador.
    expect(email.subject).toBe('Nueva solicitud ANT-2026-000123 · SEA')
  })
})
