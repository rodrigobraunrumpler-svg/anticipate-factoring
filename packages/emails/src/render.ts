import { render } from '@react-email/render'
import { createElement } from 'react'
import {
  AdvanceRequestConfirmation,
  type AdvanceRequestConfirmationData,
} from './advance-request-confirmation.js'
import {
  NewAdvanceRequestAlert,
  type NewAdvanceRequestAlertData,
} from './new-advance-request-alert.js'

export type RenderedEmail = { subject: string; html: string; text: string }

async function renderBoth(element: ReturnType<typeof createElement>) {
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })])
  return { html, text }
}

export async function renderAdvanceRequestConfirmation(
  data: AdvanceRequestConfirmationData,
): Promise<RenderedEmail> {
  const { html, text } = await renderBoth(createElement(AdvanceRequestConfirmation, data))
  return { subject: `Recibimos tu solicitud ${data.publicCode}`, html, text }
}

export async function renderNewAdvanceRequestAlert(
  data: NewAdvanceRequestAlertData,
): Promise<RenderedEmail> {
  const { html, text } = await renderBoth(createElement(NewAdvanceRequestAlert, data))
  return { subject: `Nueva solicitud ${data.publicCode} · ${data.payerName}`, html, text }
}
