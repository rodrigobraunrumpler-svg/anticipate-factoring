import { type IsoDate, isIsoDate } from '@anticipate/shared/dates'
import { type Amount, normalizeAmount } from '@anticipate/shared/money'
import type { Prisma } from './generated/client.js'

/**
 * Conversiones entre los tipos de `shared` y los de las columnas. Una fila que no se puede convertir
 * es un dato corrupto: lanzan `RangeError` y el llamador responde 500/503, nunca inventan un valor.
 */

/** Columna `@db.Date`: Prisma la lee y la escribe como la medianoche UTC del día de calendario. */
export function isoDateToDb(date: IsoDate): Date {
  return new Date(`${date}T00:00:00.000Z`)
}

export function dbDateToIso(date: Date): IsoDate {
  const iso = date.toISOString().slice(0, 10)
  if (!isIsoDate(iso)) throw new RangeError(`Fecha inválida en la base: ${iso}`)
  return iso
}

/** Columna `Decimal(14, 2)` → `Amount` de shared (texto con dos decimales). */
export function decimalToAmount(value: Prisma.Decimal): Amount {
  const amount = normalizeAmount(value.toFixed(2))
  if (amount === null || !value.equals(amount)) {
    throw new RangeError(`Monto inválido en la base: ${value.toString()}`)
  }
  return amount
}

/**
 * Columna `Decimal` chica que el dominio maneja como número (el porcentaje de adelanto,
 * `Decimal(5, 2)`). Rechaza lo que un `number` no representa sin perder dígitos.
 */
export function decimalToNumber(value: Prisma.Decimal): number {
  const number = value.toNumber()
  if (!Number.isFinite(number) || !value.equals(number)) {
    throw new RangeError(`Número inválido en la base: ${value.toString()}`)
  }
  return number
}
