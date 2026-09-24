import { z } from 'zod'
import { MESSAGES_ES } from '../errors/index.js'

export function isValidDni(value: string): boolean {
  return /^\d{8}$/.test(value)
}

export const dniSchema = z.string().trim().refine(isValidDni, { message: MESSAGES_ES.INVALID_DNI })
