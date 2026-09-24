import Decimal from 'decimal.js'
import { z } from 'zod'
import { MESSAGES_ES } from '../errors/index.js'

type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'

/**
 * Monto como texto con exactamente dos decimales, por ejemplo "25000.00". Nunca `number`.
 * Es un tipo de plantilla: los literales bien formados compilan, un `string` cualquiera no.
 */
export type Amount = `${bigint}.${Digit}${Digit}`

// El límite de 12 dígitos en la parte entera refleja la columna Decimal(14, 2) de PostgreSQL
// (STACK.md §9, D14): 12 dígitos enteros + 2 decimales, máximo 999999999999.99.
const AMOUNT_FORMAT = /^\d{1,12}\.\d{2}$/
const MAX_AMOUNT = '999999999999.99'

// Instancia propia de decimal.js: nunca se toca `Decimal.set(...)` sobre la clase global,
// porque la API y Prisma también usan decimal.js en el mismo proceso.
const MoneyDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_DOWN })

export type { Decimal } from 'decimal.js'

export const AMOUNT_ROUNDING = ['down', 'half-up'] as const
export type AmountRounding = (typeof AMOUNT_ROUNDING)[number]

const ROUNDING_MODE: Record<AmountRounding, Decimal.Rounding> = {
  down: MoneyDecimal.ROUND_DOWN,
  'half-up': MoneyDecimal.ROUND_HALF_UP,
}

/** Acepta lo que venga de un XML o de un input y lo lleva a `Amount`. Devuelve null si no es un número no negativo. */
export function normalizeAmount(value: string | number): Amount | null {
  const text =
    typeof value === 'number' ? (Number.isFinite(value) ? value.toString() : '') : value.trim()
  const parts = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(text)
  if (!parts) return null
  const whole = parts[1] ?? '0'
  const decimals = (parts[2] ?? '').padEnd(2, '0')
  return `${whole}.${decimals}` as Amount
}

export function toCents(amount: Amount): bigint {
  const [whole = '0', decimals = '00'] = amount.split('.')
  return BigInt(whole) * 100n + BigInt(decimals.padEnd(2, '0').slice(0, 2))
}

/** Los montos del dominio nunca son negativos; lanza si `cents` lo es. */
export function fromCents(cents: bigint): Amount {
  if (cents < 0n) throw new RangeError(`Monto negativo: ${cents} céntimos`)
  const text = cents.toString().padStart(3, '0')
  return `${text.slice(0, -2)}.${text.slice(-2)}` as Amount
}

/** Convierte un `Amount` ya validado a un `Decimal` de la instancia configurada del dominio. */
export function toDecimal(amount: Amount): Decimal {
  return new MoneyDecimal(amount)
}

/**
 * Redondea a dos decimales con el modo indicado y devuelve `Amount`.
 * Lanza `RangeError` si el valor no es finito, es negativo, o supera `Decimal(14, 2)`.
 */
export function fromDecimal(value: Decimal | string | number, rounding: AmountRounding): Amount {
  const asDecimal = new MoneyDecimal(value)
  if (!asDecimal.isFinite()) {
    throw new RangeError(`Monto no finito: ${asDecimal.toString()}`)
  }
  if (asDecimal.isNegative()) {
    throw new RangeError(`Monto negativo: ${asDecimal.toString()}`)
  }
  const rounded = asDecimal.toDecimalPlaces(2, ROUNDING_MODE[rounding])
  if (rounded.greaterThan(MAX_AMOUNT)) {
    throw new RangeError(`Monto fuera de rango, supera ${MAX_AMOUNT}: ${rounded.toString()}`)
  }
  return rounded.toFixed(2) as Amount
}

export function sumAmounts(...amounts: Amount[]): Amount {
  const total = amounts.reduce((acc, a) => acc.plus(toDecimal(a)), new MoneyDecimal(0))
  return total.toFixed(2) as Amount
}

/** `pct` en escala 0 a 100, con hasta dos decimales (80, 33.33). Redondea hacia abajo al céntimo. */
export function percentOf(amount: Amount, pct: number): Amount {
  const result = toDecimal(amount).times(new MoneyDecimal(pct)).dividedBy(100)
  return fromDecimal(result, 'down')
}

export function compareAmounts(a: Amount, b: Amount): -1 | 0 | 1 {
  const comparison = toDecimal(a).comparedTo(toDecimal(b))
  return comparison < 0 ? -1 : comparison > 0 ? 1 : 0
}

/** Monto ingresado por una persona: dos decimales obligatorios y mayor que cero. Su salida ya es `Amount`. */
export const amountSchema = z
  .string()
  .trim()
  .refine((v) => AMOUNT_FORMAT.test(v) && toCents(v as Amount) > 0n, {
    error: MESSAGES_ES.INVALID_AMOUNT,
  })
  .transform((v) => v as Amount)
