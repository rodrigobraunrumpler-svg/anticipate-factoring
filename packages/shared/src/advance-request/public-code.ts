export type PublicCode = { prefix: string; year: number; sequence: number }

/** `ANT-2026-000123`. El prefijo y la secuencia los da la API (config y secuencia de PostgreSQL). */
export function formatPublicCode({ prefix, year, sequence }: PublicCode): string {
  return `${prefix.toUpperCase()}-${year}-${String(sequence).padStart(6, '0')}`
}

export function parsePublicCode(text: string): PublicCode | null {
  const m = /^([A-Za-z]{2,6})-(\d{4})-(\d{6,})$/.exec(text.trim())
  if (!m) return null
  return { prefix: (m[1] ?? '').toUpperCase(), year: Number(m[2]), sequence: Number(m[3]) }
}
