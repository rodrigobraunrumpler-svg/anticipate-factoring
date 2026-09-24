import { z } from 'zod'
import { VALIDATION_MESSAGES_ES } from '../errors/index.js'

/** Monedas que el sistema sabe representar. Cuáles acepta cada pagador es un dato de contexto, no una constante. */
export const CURRENCIES = ['PEN', 'USD'] as const
export type Currency = (typeof CURRENCIES)[number]
export const currencySchema = z.enum(CURRENCIES, { error: VALIDATION_MESSAGES_ES.money.currency })

export function isCurrency(value: string): value is Currency {
  return (CURRENCIES as readonly string[]).includes(value)
}
