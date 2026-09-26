import { TZDate } from '@date-fns/tz'
// Función por función y no desde el índice de date-fns, que carga todos sus módulos (architecture.test.ts).
import { format } from 'date-fns/format'
import { type IsoDate, isIsoDate } from './iso-date.js'

/**
 * Fechas para leer (correos, admin): el orden día/mes/año de Perú. Una fecha de calendario se escribe
 * tal cual, sin zona horaria (un vencimiento es un día, no un instante); un instante se escribe en la
 * zona que se pide, que para la operación es `LIMA_TIME_ZONE`.
 */

/** "30/11/2026". Lanza si la fecha no es una `IsoDate` válida. */
export function formatIsoDate(date: IsoDate): string {
  if (!isIsoDate(date)) throw new RangeError(`Fecha inválida: ${date}`)
  const [year, month, day] = date.split('-')
  return `${day}/${month}/${year}`
}

/** "24/09/2026 10:00": el instante visto desde `timeZone`, con hora de 24 h. */
export function formatDateTimeIn(timeZone: string, instant: Date): string {
  if (Number.isNaN(instant.getTime())) throw new RangeError('Instante inválido')
  return format(new TZDate(instant, timeZone), 'dd/MM/yyyy HH:mm')
}
