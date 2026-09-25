import { z } from 'zod'

/**
 * Piezas comunes de los esquemas por tema. Todos los mensajes están en español y ninguno repite el
 * valor recibido: una variable inválida puede ser un secreto y el error termina en los logs.
 * `parseConfig` quita antes las variables vacías, así que "falta" y "vacía" dan el mismo mensaje.
 */
export const requiredText = z
  .string({ error: 'es obligatoria' })
  .trim()
  .min(1, { error: 'es obligatoria' })

/** `true` o `false` literales. `z.coerce.boolean()` convertiría "false" en `true`. */
export function flag(fallback: boolean) {
  return z
    .enum(['true', 'false'], { error: 'debe ser true o false' })
    .default(fallback ? 'true' : 'false')
    .transform((value) => value === 'true')
}

/** Entero sin signo escrito en decimal: rechaza "1e3", "0x10", "12.5" y "-1", que `Number` aceptaría. */
export function integer(options: { fallback: number; min: number; max: number }) {
  return z
    .string({ error: 'debe ser un número entero' })
    .trim()
    .regex(/^\d+$/, { error: 'debe ser un número entero' })
    .transform(Number)
    .pipe(
      z
        .number()
        .min(options.min, { error: `debe ser al menos ${options.min}` })
        .max(options.max, { error: `debe ser como máximo ${options.max}` }),
    )
    .default(options.fallback)
}

function hasProtocol(value: string, protocols: readonly string[]): boolean {
  try {
    return protocols.includes(new URL(value).protocol)
  } catch {
    return false
  }
}

export const httpUrl = requiredText.refine((value) => hasProtocol(value, ['http:', 'https:']), {
  error: 'debe ser una URL que empiece con http:// o https://',
})

/** Host, puerto y base de una URL de PostgreSQL, o `null` si no es una URL `postgresql://` completa. */
export function postgresTarget(
  value: string,
): { host: string; port: string; database: string } | null {
  try {
    const url = new URL(value)
    const database = decodeURIComponent(url.pathname.slice(1))
    const isPostgres = url.protocol === 'postgresql:' || url.protocol === 'postgres:'
    if (!isPostgres || url.hostname === '' || database === '' || database.includes('/')) return null
    return { host: url.hostname, port: url.port || '5432', database }
  } catch {
    return null
  }
}

export const postgresUrl = requiredText.refine((value) => postgresTarget(value) !== null, {
  error: 'debe ser una URL postgresql:// con host y nombre de base de datos',
})

export const emailAddress = requiredText.pipe(z.email({ error: 'debe ser un correo válido' }))
