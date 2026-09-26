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

/**
 * Lo que se le pasa a html-to-text (`htmlToTextOptions` de `render`): selectores que se suman a los de
 * react-email. Se declara aquí porque el paquete no publica los tipos de html-to-text.
 */
type HtmlToTextOptions = {
  readonly selectors: readonly {
    readonly selector: string
    readonly format?: 'anchor'
    readonly options: Readonly<Record<string, boolean>>
  }[]
}

async function renderBoth(
  element: ReturnType<typeof createElement>,
  htmlToTextOptions?: HtmlToTextOptions,
) {
  const [html, text] = await Promise.all([
    render(element),
    render(element, { plainText: true, htmlToTextOptions }),
  ])
  return { html, text }
}

/**
 * Texto plano del aviso al equipo: los títulos quedan como se escriben (html-to-text los pasa a
 * mayúsculas) y el celular y el correo van sin su `tel:` o `mailto:` repetido al lado.
 */
const ALERT_TEXT_OPTIONS: HtmlToTextOptions = {
  selectors: [
    { selector: 'h1', options: { uppercase: false } },
    { selector: 'h2', options: { uppercase: false } },
    { selector: 'a[href^="tel:"]', format: 'anchor', options: { ignoreHref: true } },
    { selector: 'a[href^="mailto:"]', format: 'anchor', options: { ignoreHref: true } },
  ],
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
  const { html, text } = await renderBoth(
    createElement(NewAdvanceRequestAlert, data),
    ALERT_TEXT_OPTIONS,
  )
  return { subject: `Nueva solicitud ${data.publicCode} · ${data.payerName}`, html, text }
}
