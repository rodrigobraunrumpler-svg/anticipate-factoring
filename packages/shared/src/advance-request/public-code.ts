import { z } from 'zod'
import { VALIDATION_MESSAGES_ES } from '../errors/index.js'

export type PublicCode = { prefix: string; year: number; sequence: number }

/**
 * `ANT-2026-000123`: prefijo de 2 a 6 letras, año de cuatro dígitos y secuencia de al menos seis.
 * La secuencia se acota a 15 dígitos para que `Number` la represente sin perder precisión.
 */
const PUBLIC_CODE_PATTERN = /^([A-Z]{2,6})-(\d{4})-(\d{6,15})$/

/** `ANT-2026-000123`. El prefijo y la secuencia los da la API (config y secuencia de PostgreSQL). */
export function formatPublicCode({ prefix, year, sequence }: PublicCode): string {
  return `${prefix.toUpperCase()}-${year}-${String(sequence).padStart(6, '0')}`
}

export function parsePublicCode(text: string): PublicCode | null {
  const m = PUBLIC_CODE_PATTERN.exec(text.trim().toUpperCase())
  if (!m) return null
  return { prefix: m[1] ?? '', year: Number(m[2]), sequence: Number(m[3]) }
}

/** Código público recibido de afuera (evento, URL, búsqueda). Su salida es canónica: en mayúsculas. */
export const publicCodeSchema = z
  .string({ error: VALIDATION_MESSAGES_ES.advanceRequest.publicCode })
  .trim()
  .toUpperCase()
  .regex(PUBLIC_CODE_PATTERN, { error: VALIDATION_MESSAGES_ES.advanceRequest.publicCode })
