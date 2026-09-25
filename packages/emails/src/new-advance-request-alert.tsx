import { Button, Heading, Text } from 'react-email'
import { invoicesLabel } from './advance-request-confirmation.js'
import { Layout } from './layout.js'

export type NewAdvanceRequestAlertData = {
  publicCode: string
  payerName: string
  supplierName: string
  supplierRuc: string
  requestedAmount: string
  currency: string
  invoiceCount: number
  adminUrl: string
}

export function NewAdvanceRequestAlert(props: NewAdvanceRequestAlertData) {
  return (
    <Layout preview={`Nueva solicitud ${props.publicCode} de ${props.supplierName}`}>
      <Heading as="h1">Nueva solicitud {props.publicCode}</Heading>
      <Text>
        {props.supplierName} (RUC {props.supplierRuc}) pide un adelanto sobre facturas a{' '}
        {props.payerName}.
      </Text>
      <Text>
        Monto solicitado: {props.currency} {props.requestedAmount} ·{' '}
        {invoicesLabel(props.invoiceCount)}
      </Text>
      <Button href={props.adminUrl}>Ver en el admin</Button>
    </Layout>
  )
}
