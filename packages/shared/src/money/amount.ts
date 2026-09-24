import Decimal from 'decimal.js'
import { z } from 'zod'
import { MESSAGES_ES } from '../errors/index.js'

/**
 * Monto como texto con exactamente dos decimales, por ejemplo "25000.00". Nunca `number`.
 * Es un tipo de plantilla anclado (rechaza un `string` cualquiera en tiempo de compilación),
 * pero no una unión: no fija los dígitos decimales en el tipo para que TypeScript no la expanda
 * en un tipo literal con cientos de miembros (eso inflaba los `.d.ts` generados, ver STACK.md).
 * El formato exacto (dos decimales, hasta 12 dígitos enteros) lo garantiza en runtime
 * `AMOUNT_FORMAT`/`normalizeAmount`, no el tipo.
 */
export type Amount = `${bigint}.${string}`

// El límite de 12 dígitos en la parte entera (sin contar ceros a la izquierda) refleja la columna
// Decimal(14, 2) de PostgreSQL (STACK.md §9, D14): 12 dígitos enteros + 2 decimales, máximo
// 999999999999.99. Lo aplica `normalizeAmount`.
const MAX_WHOLE_DIGITS = 12

/** Monto escrito por una persona: dos decimales obligatorios. */
const ENTERED_AMOUNT_FORMAT = /^\d+\.\d{2}$/

/** Mayor monto representable en `Decimal(14, 2)`. Ninguna operación del dominio devuelve uno mayor. */
export const MAX_AMOUNT: Amount = '999999999999.99'
const MAX_CENTS = 99_999_999_999_999n

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

/**
 * Acepta lo que venga de un XML o de un input y lo lleva al `Amount` canónico: dos decimales y sin
 * ceros a la izquierda (`'00008000.5'` → `'8000.50'`). Devuelve null si no es un número no negativo
 * con hasta dos decimales o si no cabe en `Decimal(14, 2)`.
 */
export function normalizeAmount(value: string | number): Amount | null {
  const text =
    typeof value === 'number' ? (Number.isFinite(value) ? value.toString() : '') : value.trim()
  const parts = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text)
  if (!parts) return null
  const whole = (parts[1] ?? '0').replace(/^0+(?=\d)/, '')
  if (whole.length > MAX_WHOLE_DIGITS) return null
  const decimals = (parts[2] ?? '').padEnd(2, '0')
  return `${whole}.${decimals}` as Amount
}

export function toCents(amount: Amount): bigint {
  const [whole = '0', decimals = '00'] = amount.split('.')
  return BigInt(whole) * 100n + BigInt(decimals.padEnd(2, '0').slice(0, 2))
}

/** Los montos del dominio nunca son negativos ni superan `Decimal(14, 2)`; lanza `RangeError` si no. */
export function fromCents(cents: bigint): Amount {
  if (cents < 0n) throw new RangeError(`Monto negativo: ${cents} céntimos`)
  if (cents > MAX_CENTS) {
    throw new RangeError(`Monto fuera de rango, supera ${MAX_AMOUNT}: ${cents} céntimos`)
  }
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

/**
 * Suma exacta. Lanza `RangeError` si el total supera `Decimal(14, 2)`: quien sume montos que vienen
 * de afuera (por ejemplo, los netos de varias facturas) debe comprobar el rango antes y devolver un
 * `Problem`, como hace `validateInvoices`.
 */
export function sumAmounts(...amounts: Amount[]): Amount {
  const total = amounts.reduce((acc, a) => acc.plus(toDecimal(a)), new MoneyDecimal(0))
  if (total.greaterThan(MAX_AMOUNT)) {
    throw new RangeError(`Monto fuera de rango, supera ${MAX_AMOUNT}: ${total.toFixed(2)}`)
  }
  return total.toFixed(2) as Amount
}

/**
 * `pct` en escala 0 a 100 (80, 33.33). Redondea hacia abajo al céntimo. Lanza `RangeError` si `pct`
 * no es finito o está fuera de 0 a 100: el porcentaje es configuración, no dato del usuario.
 */
export function percentOf(amount: Amount, pct: number): Amount {
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new RangeError(`Porcentaje fuera de rango (0 a 100): ${pct}`)
  }
  const result = toDecimal(amount).times(new MoneyDecimal(pct)).dividedBy(100)
  return fromDecimal(result, 'down')
}

export function compareAmounts(a: Amount, b: Amount): -1 | 0 | 1 {
  const comparison = toDecimal(a).comparedTo(toDecimal(b))
  return comparison < 0 ? -1 : comparison > 0 ? 1 : 0
}

/** Monto escrito por una persona, ya canónico, o null si no tiene dos decimales o no es mayor que cero. */
function parseEnteredAmount(text: string): Amount | null {
  if (!ENTERED_AMOUNT_FORMAT.test(text)) return null
  const amount = normalizeAmount(text)
  return amount !== null && toCents(amount) > 0n ? amount : null
}

/**
 * Monto ingresado por una persona: dos decimales obligatorios y mayor que cero. Su salida es el
 * `Amount` canónico (`'00008000.00'` → `'8000.00'`), el mismo que se guarda y se compara.
 */
export const amountSchema = z
  .string({ error: MESSAGES_ES.INVALID_AMOUNT })
  .trim()
  .refine((v) => parseEnteredAmount(v) !== null, { error: MESSAGES_ES.INVALID_AMOUNT })
  .transform((v) => parseEnteredAmount(v) as Amount)
