import { Heading, Text } from 'react-email'
import { Layout } from './layout.js'

export type AdvanceRequestConfirmationData = {
  contactName: string
  publicCode: string
  payerName: string
  requestedAmount: string
  currency: string
  invoiceCount: number
}

export const invoicesLabel = (count: number) => `${count} ${count === 1 ? 'factura' : 'facturas'}`

export function AdvanceRequestConfirmation(props: AdvanceRequestConfirmationData) {
  return (
    <Layout preview={`Recibimos tu solicitud ${props.publicCode}`}>
      <Heading as="h1">Recibimos tu solicitud</Heading>
      <Text>Hola, {props.contactName}:</Text>
      <Text>
        Registramos tu solicitud de adelanto <strong>{props.publicCode}</strong> para las facturas
        emitidas a {props.payerName}.
      </Text>
      <Text>
        Monto solicitado: {props.currency} {props.requestedAmount} ·{' '}
        {invoicesLabel(props.invoiceCount)}
      </Text>
      <Text>
        Próximo paso: nuestro equipo te llamará para revisar la solicitud y pedirte los documentos
        del representante legal (DNI y vigencia de poder).
      </Text>
    </Layout>
  )
}
