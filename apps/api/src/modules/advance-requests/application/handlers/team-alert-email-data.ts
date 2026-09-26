import type { NewAdvanceRequestAlertData, NewAdvanceRequestAlertInvoice } from '@anticipate/emails'
import {
  CAVALI_REGISTRATION_LABELS,
  CONTACT_TIME_SLOT_LABELS,
} from '@anticipate/shared/advance-request'
import { formatDateTimeIn, formatIsoDate, LIMA_TIME_ZONE } from '@anticipate/shared/dates'
import type {
  TeamAlertInvoice,
  TeamAlertNotificationView,
} from '#/modules/advance-requests/application/ports/advance-request-notification-reader.port.js'

export type TeamAlertEmailDataOptions = {
  /** `ADMIN_BASE_URL` sin barra final, o `null` si no hay admin: el correo no lleva enlace. */
  adminBaseUrl: string | null
}

/** Celular peruano de `shared` (`^9\d{8}$`): nueve dígitos que empiezan con 9. */
const PERUVIAN_MOBILE = /^9\d{8}$/

function mobileOf(mobile: string): { mobile: string; mobileHref: string } {
  if (!PERUVIAN_MOBILE.test(mobile)) {
    return { mobile, mobileHref: `tel:${mobile.replace(/[^\d+]/g, '')}` }
  }
  return {
    mobile: `${mobile.slice(0, 3)} ${mobile.slice(3, 6)} ${mobile.slice(6)}`,
    mobileHref: `tel:+51${mobile}`,
  }
}

function roleOf(view: TeamAlertNotificationView): string {
  if (view.isLegalRepresentative) return 'Representante legal'
  return view.contactJobTitle === null
    ? 'No es representante legal'
    : `${view.contactJobTitle} (no es representante legal)`
}

/** Para comparar nombres escritos por personas: sin mayúsculas, espacios de más ni formas Unicode distintas. */
const normalized = (text: string): string =>
  text.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('es')

/**
 * El representante registrado, solo si no coincide con lo que escribió el contacto. La solicitud
 * queda ligada al representante del proveedor con el mismo DNI; si ya existía (de una solicitud
 * anterior), conserva el nombre y el cargo con que se registró, y el equipo necesita ver ese.
 */
function registeredRepresentativeOf(view: TeamAlertNotificationView): string | null {
  const representative = view.legalRepresentative
  if (representative === null) return null
  const sameName = normalized(representative.fullName) === normalized(view.contactFullName)
  const sameJobTitle =
    representative.jobTitle === null ||
    (view.contactJobTitle !== null &&
      normalized(representative.jobTitle) === normalized(view.contactJobTitle))
  if (sameName && sameJobTitle) return null
  return representative.jobTitle === null
    ? representative.fullName
    : `${representative.fullName} (${representative.jobTitle})`
}

function dueOf(invoice: TeamAlertInvoice): string {
  const last = formatIsoDate(invoice.dueDate)
  if (invoice.installmentCount <= 1 || invoice.firstDueDate === null) return `vence el ${last}`
  const first = formatIsoDate(invoice.firstDueDate)
  return `${invoice.installmentCount} cuotas: la primera vence el ${first} y la última el ${last}`
}

function invoiceOf(invoice: TeamAlertInvoice): NewAdvanceRequestAlertInvoice {
  return {
    seriesNumber: invoice.seriesNumber,
    netPendingAmount: invoice.netPendingAmount,
    due: dueOf(invoice),
  }
}

/**
 * Los datos del aviso al equipo escritos para leer: la hora de recepción en Lima, las fechas de
 * calendario en día/mes/año, las etiquetas en español de `shared` y el celular listo para llamar. Los
 * textos del proveedor pasan tal cual: los escapa la plantilla.
 */
export function toTeamAlertEmailData(
  view: TeamAlertNotificationView,
  options: TeamAlertEmailDataOptions,
): NewAdvanceRequestAlertData {
  return {
    publicCode: view.publicCode,
    payerName: view.payerShortName,
    receivedAt: formatDateTimeIn(LIMA_TIME_ZONE, view.createdAt),
    company: { legalName: view.supplierLegalName, ruc: view.supplierRuc },
    contact: {
      fullName: view.contactFullName,
      ...mobileOf(view.contactMobile),
      email: view.contactEmail,
      timeSlot: CONTACT_TIME_SLOT_LABELS[view.contactTimeSlot],
      role: roleOf(view),
    },
    legalRepresentative: registeredRepresentativeOf(view),
    requestedAmount: view.requestedAmount,
    currency: view.currency,
    purpose: view.purpose,
    cavaliRegistration: CAVALI_REGISTRATION_LABELS[view.cavaliRegistration],
    invoices: view.invoices.map(invoiceOf),
    adminUrl:
      options.adminBaseUrl === null
        ? null
        : `${options.adminBaseUrl}/advance-requests/${encodeURIComponent(view.id)}`,
  }
}
