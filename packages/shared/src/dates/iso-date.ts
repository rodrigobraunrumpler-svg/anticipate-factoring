import { TZDate } from '@date-fns/tz'
// Función por función y no desde el índice de date-fns, que carga todos sus módulos (architecture.test.ts).
import { addDays } from 'date-fns/addDays'
import { differenceInCalendarDays } from 'date-fns/differenceInCalendarDays'
import { format } from 'date-fns/format'
import { formatISO } from 'date-fns/formatISO'
import { isValid } from 'date-fns/isValid'
import { parseISO } from 'date-fns/parseISO'
import { z } from 'zod'
import { VALIDATION_MESSAGES_ES } from '../errors/index.js'

/**
 * Fecha de calendario sin hora ni zona: "2026-09-23". Tipo de plantilla anclado (rechaza un
 * `string` cualquiera en tiempo de compilación), pero no una unión: no fija los dígitos en el
 * tipo para que TypeScript no la expanda en un tipo literal con miles de miembros (eso inflaba
 * los `.d.ts` generados, ver STACK.md). El formato exacto (`AAAA-MM-DD`, del 0001-01-01 al
 * 9999-12-31) lo garantiza en runtime `ISO_DATE_FORMAT`/`isIsoDate`, no el tipo.
 */
export type IsoDate = `${bigint}-${string}`

/** Zona horaria de operación. Perú no tiene horario de verano. */
export const LIMA_TIME_ZONE = 'America/Lima'

/**
 * Año de 0001 a 9999: el rango de cuatro cifras que guarda `date` de PostgreSQL (y `timestamptz`).
 * PostgreSQL no tiene año 0 (`'0000-01-01'::date` es "date/time field value out of range"), aunque
 * JS lo lea como el año 1 a. C. del calendario proléptico y `formatISO` lo devuelva igual. Es la
 * gemela del tipo de las columnas de fecha: una fecha que cumple esto nunca hace fallar un INSERT.
 */
const ISO_DATE_FORMAT = /^(?!0000)\d{4}-\d{2}-\d{2}$/

function parse(date: string): Date {
  if (!ISO_DATE_FORMAT.test(date)) throw new Error(`Fecha inválida: ${date}`)
  const parsed = parseISO(date)
  if (!isValid(parsed) || formatISO(parsed, { representation: 'date' }) !== date) {
    throw new Error(`Fecha inválida: ${date}`)
  }
  return parsed
}

export function isIsoDate(value: string): value is IsoDate {
  try {
    parse(value)
    return true
  } catch {
    return false
  }
}

/** Días de calendario de `from` a `to`. Negativo si `to` es anterior. Lanza si alguna fecha es inválida. */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return differenceInCalendarDays(parse(to), parse(from))
}

/** Lanza si `date` es inválida o si el resultado queda fuera del rango de `IsoDate`. */
export function addDaysIso(date: IsoDate, days: number): IsoDate {
  const result = formatISO(addDays(parse(date), days), { representation: 'date' })
  if (!isIsoDate(result)) throw new Error(`Fecha fuera de rango: ${date} + ${days} días`)
  return result
}

/** Fecha de calendario de `now` vista desde `timeZone`. `now` se recibe por parámetro: shared no consulta el reloj. */
export function todayIn(timeZone: string, now: Date): IsoDate {
  return format(new TZDate(now, timeZone), 'yyyy-MM-dd') as IsoDate
}

/** Su salida ya es `IsoDate`. */
export const isoDateSchema = z
  .string({ error: VALIDATION_MESSAGES_ES.dates.isoDate })
  .trim()
  .refine(isIsoDate, { error: VALIDATION_MESSAGES_ES.dates.isoDate })
  .transform((v) => v as IsoDate)
