/** API de Mailpit: `MAILPIT_API_URL` de `.env.test` (en CI, del job). */
const MAILPIT_API_URL = process.env.MAILPIT_API_URL ?? 'http://127.0.0.1:8025'

export type MailpitMessage = {
  ID: string
  Subject: string
  To: { Address: string }[]
  Tags: string[]
}
export type MailpitMessageDetail = { Subject: string; HTML: string; Text: string; Tags: string[] }

async function mailpit(path: string, method = 'GET'): Promise<Response> {
  const response = await fetch(`${MAILPIT_API_URL}${path}`, { method })
  if (!response.ok) throw new Error(`Mailpit ${method} ${path}: ${response.status}`)
  return response
}

export async function clearMailbox(): Promise<void> {
  await mailpit('/api/v1/messages', 'DELETE')
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
