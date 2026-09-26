import { Button, Heading, Link, Text } from 'react-email'
import { Layout } from './layout.js'

/** Una factura de la solicitud, con los montos y las fechas ya escritos para leer. */
export type NewAdvanceRequestAlertInvoice = {
  seriesNumber: string
  /** Neto pendiente, en la moneda de la solicitud (`10620.00`). */
  netPendingAmount: string
  /** Vencimiento o resumen de las cuotas (`vence el 30/11/2026`). */
  due: string
}

/**
 * Aviso al equipo de una solicitud nueva. Todo llega escrito para leer (fechas en hora de Lima,
 * etiquetas en español): la plantilla no conoce zonas horarias ni catálogos. Los textos del proveedor
 * (nombres, razón social, cargo, motivo) los escapa React en el HTML; ninguno va en el asunto.
 */
export type NewAdvanceRequestAlertData = {
  publicCode: string
  payerName: string
  /** Fecha y hora de recepción en Lima (`24/09/2026 10:00`). */
  receivedAt: string
  company: { legalName: string; ruc: string }
  contact: {
    fullName: string
    /** Celular para leer (`987 654 321`). */
    mobile: string
    /** Enlace para llamar (`tel:+51987654321`). */
    mobileHref: string
    email: string
    /** Horario preferido, con su etiqueta. */
    timeSlot: string
    /** «Representante legal» o su cargo, aclarando que no lo es. */
    role: string
  }
  /** El representante legal registrado del proveedor, solo si no coincide con el contacto. */
  legalRepresentative: string | null
  requestedAmount: string
  currency: string
  purpose: string | null
  /** ¿Las facturas ya están en Cavali?, con su etiqueta. */
  cavaliRegistration: string
  invoices: readonly NewAdvanceRequestAlertInvoice[]
  /** Detalle en el admin, solo si existe (`ADMIN_BASE_URL`). */
  adminUrl: string | null
}

const sectionTitle = { fontSize: '16px', margin: '24px 0 4px' }
const line = { margin: '4px 0' }

export function NewAdvanceRequestAlert(props: NewAdvanceRequestAlertData) {
  const { company, contact, currency } = props
  return (
    <Layout preview={`Nueva solicitud ${props.publicCode} de ${company.legalName}`}>
      <Heading as="h1">{`Nueva solicitud ${props.publicCode}`}</Heading>
      <Text>{`Recibida el ${props.receivedAt} (hora de Lima) para ${props.payerName}.`}</Text>

      <Heading as="h2" style={sectionTitle}>
        Contacto
      </Heading>
      <Text style={line}>{`${contact.fullName} · ${contact.role}`}</Text>
      <Text style={line}>
        {'Celular: '}
        <Link href={contact.mobileHref}>{contact.mobile}</Link>
      </Text>
      <Text style={line}>
        {'Correo: '}
        <Link href={`mailto:${contact.email}`}>{contact.email}</Link>
      </Text>
      <Text style={line}>{`Horario preferido: ${contact.timeSlot}`}</Text>
      {props.legalRepresentative !== null && (
        <Text style={line}>{`Representante legal registrado: ${props.legalRepresentative}`}</Text>
      )}

      <Heading as="h2" style={sectionTitle}>
        Empresa
      </Heading>
      <Text style={line}>{`${company.legalName} · RUC ${company.ruc}`}</Text>

      <Heading as="h2" style={sectionTitle}>
        Solicitud
      </Heading>
      <Text style={line}>{`Monto solicitado: ${currency} ${props.requestedAmount}`}</Text>
      {props.purpose !== null && <Text style={line}>{`Motivo: ${props.purpose}`}</Text>}
      <Text style={line}>{`¿Facturas registradas en Cavali?: ${props.cavaliRegistration}`}</Text>

      <Heading as="h2" style={sectionTitle}>
        {`Facturas (${props.invoices.length})`}
      </Heading>
      {props.invoices.map((invoice, index) => (
        <Text key={`${index}:${invoice.seriesNumber}`} style={line}>
          {`${invoice.seriesNumber} · ${currency} ${invoice.netPendingAmount} neto pendiente · ${invoice.due}`}
        </Text>
      ))}

      {props.adminUrl !== null && <Button href={props.adminUrl}>Ver en el admin</Button>}
    </Layout>
  )
}
