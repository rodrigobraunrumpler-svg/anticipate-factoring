import { describe, expect, it } from 'vitest'
import type { TeamAlertNotificationView } from '#/modules/advance-requests/application/ports/advance-request-notification-reader.port.js'
import { toTeamAlertEmailData } from './team-alert-email-data.js'

const REQUEST_ID = '0192f3a0-0000-7000-8000-000000000001'

const TEAM_ALERT_VIEW: TeamAlertNotificationView = {
  id: REQUEST_ID,
  publicCode: 'ANT-2026-000001',
  payerShortName: 'SEA',
  supplierLegalName: 'PROVEEDOR EJEMPLO S.A.C.',
  supplierRuc: '20100070970',
  contactFullName: 'Ana Pérez',
  contactEmail: 'ana@proveedor.pe',
  contactMobile: '987654321',
  contactTimeSlot: 'MORNING',
  isLegalRepresentative: true,
  contactJobTitle: null,
  legalRepresentative: { fullName: 'Ana Pérez', jobTitle: null },
  requestedAmount: '8000.00',
  currency: 'PEN',
  purpose: 'Capital de trabajo',
  cavaliRegistration: 'UNKNOWN',
  invoiceCount: 2,
  invoices: [
    {
      seriesNumber: 'F001-123',
      netPendingAmount: '10620.00',
      dueDate: '2026-11-30',
      installmentCount: 2,
      firstDueDate: '2026-10-30',
    },
    {
      seriesNumber: 'F001-124',
      netPendingAmount: '500.00',
      dueDate: '2026-12-15',
      installmentCount: 1,
      firstDueDate: '2026-12-15',
    },
  ],
  // 10:00 del 24 de septiembre en Lima.
  createdAt: new Date('2026-09-24T15:00:00.000Z'),
}

describe('toTeamAlertEmailData', () => {
  it('escribe cada dato para leer: hora de Lima, etiquetas en español, celular agrupado y resumen de cuotas', () => {
    expect(toTeamAlertEmailData(TEAM_ALERT_VIEW, { adminBaseUrl: null })).toEqual({
      publicCode: 'ANT-2026-000001',
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
    })
  })

  it('con ADMIN_BASE_URL enlaza al detalle de la solicitud', () => {
    expect(
      toTeamAlertEmailData(TEAM_ALERT_VIEW, { adminBaseUrl: 'https://admin.anticipate.pe' })
        .adminUrl,
    ).toBe(`https://admin.anticipate.pe/advance-requests/${REQUEST_ID}`)
  })

  it('un contacto que no es el representante legal muestra su cargo y lo aclara', () => {
    const data = toTeamAlertEmailData(
      {
        ...TEAM_ALERT_VIEW,
        isLegalRepresentative: false,
        contactJobTitle: 'Jefa de finanzas',
        legalRepresentative: null,
      },
      { adminBaseUrl: null },
    )
    expect(data.contact.role).toBe('Jefa de finanzas (no es representante legal)')
    expect(data.legalRepresentative).toBeNull()
    expect(
      toTeamAlertEmailData(
        { ...TEAM_ALERT_VIEW, isLegalRepresentative: false, contactJobTitle: null },
        { adminBaseUrl: null },
      ).contact.role,
    ).toBe('No es representante legal')
  })

  it('el representante registrado aparece solo si no coincide con lo que escribió el contacto', () => {
    const withRepresentative = (fullName: string, jobTitle: string | null) =>
      toTeamAlertEmailData(
        {
          ...TEAM_ALERT_VIEW,
          contactJobTitle: 'Gerente general',
          legalRepresentative: { fullName, jobTitle },
        },
        { adminBaseUrl: null },
      ).legalRepresentative
    // Mismo nombre, con otras mayúsculas o espacios, y mismo cargo (o sin cargo registrado).
    expect(withRepresentative('  ANA   pérez ', 'Gerente general')).toBeNull()
    expect(withRepresentative('Ana Pérez', null)).toBeNull()
    // El representante ya estaba registrado (mismo DNI) con otro nombre o cargo: el equipo ve el registrado.
    expect(withRepresentative('Ana María Pérez Gómez', 'Gerente general')).toBe(
      'Ana María Pérez Gómez (Gerente general)',
    )
    expect(withRepresentative('Ana Pérez', 'Apoderada')).toBe('Ana Pérez (Apoderada)')
  })

  it('un celular que no tiene la forma peruana se muestra tal cual', () => {
    const data = toTeamAlertEmailData(
      { ...TEAM_ALERT_VIEW, contactMobile: '12345' },
      { adminBaseUrl: null },
    )
    expect(data.contact.mobile).toBe('12345')
    expect(data.contact.mobileHref).toBe('tel:12345')
  })

  it('una factura sin cuotas leídas usa su vencimiento', () => {
    const [invoice] = toTeamAlertEmailData(
      {
        ...TEAM_ALERT_VIEW,
        invoices: [
          {
            seriesNumber: 'F001-9',
            netPendingAmount: '1.00',
            dueDate: '2026-12-01',
            installmentCount: 0,
            firstDueDate: null,
          },
        ],
      },
      { adminBaseUrl: null },
    ).invoices
    expect(invoice?.due).toBe('vence el 01/12/2026')
  })
})
