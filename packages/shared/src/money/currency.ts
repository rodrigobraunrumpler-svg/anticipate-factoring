import { z } from 'zod'

/** Monedas que el sistema sabe representar. Cuáles acepta cada pagador es un dato de contexto, no una constante. */
export const CURRENCIES = ['PEN', 'USD'] as const
export type Currency = (typeof CURRENCIES)[number]
export const currencySchema = z.enum(CURRENCIES)
