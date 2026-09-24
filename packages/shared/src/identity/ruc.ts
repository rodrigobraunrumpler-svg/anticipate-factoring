import { z } from 'zod'
import { MESSAGES_ES } from '../errors/index.js'

/** Pesos del algoritmo módulo 11 de SUNAT para los diez primeros dígitos. */
const WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2] as const

/** Prefijos que SUNAT asigna: 10 persona natural, 15/16/17 otros tipos, 20 persona jurídica. */
const VALID_PREFIXES = new Set(['10', '15', '16', '17', '20'])

export function isValidRuc(value: string): boolean {
  if (!/^\d{11}$/.test(value)) return false
  if (!VALID_PREFIXES.has(value.slice(0, 2))) return false
  const sum = WEIGHTS.reduce((acc, weight, i) => acc + weight * Number(value[i]), 0)
  const remainder = 11 - (sum % 11)
  const checkDigit = remainder === 10 ? 0 : remainder === 11 ? 1 : remainder
  return checkDigit === Number(value[10])
}

export const rucSchema = z
  .string({ error: MESSAGES_ES.INVALID_RUC })
  .trim()
  .refine(isValidRuc, { error: MESSAGES_ES.INVALID_RUC })
