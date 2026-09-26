/**
 * API de Mailpit: `MAILPIT_API_URL` de `.env.test` (en CI, del job). El buzón es compartido (otros
 * tests, otras copias del repositorio y quien lo mira en el navegador): nunca se vacía. Cada test
 * envía a destinatarios propios, con un id único, y busca solo los suyos con `findMailsTo`.
 */
const MAILPIT_API_URL = process.env.MAILPIT_API_URL ?? 'http://127.0.0.1:8025'

export type MailpitMessage = {
  ID: string
  Subject: string
  To: { Address: string }[]
  Tags: string[]
}
export type MailpitMessageDetail = { Subject: string; HTML: string; Text: string; Tags: string[] }

async function mailpit(path: string): Promise<Response> {
  const response = await fetch(`${MAILPIT_API_URL}${path}`)
  if (!response.ok) throw new Error(`Mailpit GET ${path}: ${response.status}`)
  return response
}

export async function findMailsTo(email: string): Promise<MailpitMessage[]> {
  const response = await mailpit(`/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
  return ((await response.json()) as { messages: MailpitMessage[] }).messages
}

export async function readMail(id: string): Promise<MailpitMessageDetail> {
  return (await (await mailpit(`/api/v1/message/${id}`)).json()) as MailpitMessageDetail
}

export async function readMailHeaders(id: string): Promise<Record<string, string[]>> {
  return (await (await mailpit(`/api/v1/message/${id}/headers`)).json()) as Record<string, string[]>
}
