import { TZDate } from '@date-fns/tz'
import { addDays, differenceInCalendarDays, format, formatISO, isValid, parseISO } from 'date-fns'
import { z } from 'zod'

/**
 * Fecha de calendario sin hora ni zona: "2026-09-23". Tipo de plantilla anclado (rechaza un
 * `string` cualquiera en tiempo de compilación), pero no una unión: no fija los dígitos en el
 * tipo para que TypeScript no la expanda en un tipo literal con miles de miembros (eso inflaba
 * los `.d.ts` generados, ver STACK.md). El formato exacto (`AAAA-MM-DD`) lo garantiza en runtime
 * `ISO_DATE_FORMAT`/`isIsoDate`, no el tipo.
 */
export type IsoDate = `${bigint}-${string}`

/** Zona horaria de operación. Perú no tiene horario de verano. */
export const LIMA_TIME_ZONE = 'America/Lima'

const ISO_DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/

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

export function addDaysIso(date: IsoDate, days: number): IsoDate {
  return formatISO(addDays(parse(date), days), { representation: 'date' }) as IsoDate
}

/** Fecha de calendario de `now` vista desde `timeZone`. `now` se recibe por parámetro: shared no consulta el reloj. */
export function todayIn(timeZone: string, now: Date): IsoDate {
  return format(new TZDate(now, timeZone), 'yyyy-MM-dd') as IsoDate
}

/** Su salida ya es `IsoDate`. */
export const isoDateSchema = z
  .string()
  .trim()
  .refine(isIsoDate, { error: 'La fecha debe tener el formato AAAA-MM-DD.' })
  .transform((v) => v as IsoDate)
