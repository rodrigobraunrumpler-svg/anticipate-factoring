import { z } from 'zod'
import { MESSAGES_ES } from '../errors/index.js'

export function isValidDni(value: string): boolean {
  return /^\d{8}$/.test(value)
}

export const dniSchema = z
  .string({ error: MESSAGES_ES.INVALID_DNI })
  .trim()
  .refine(isValidDni, { error: MESSAGES_ES.INVALID_DNI })
