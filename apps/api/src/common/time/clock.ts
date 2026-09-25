/**
 * Reloj de las reglas de negocio: "hoy" se calcula con `todayIn(LIMA_TIME_ZONE, clock.now())`. Los
 * tiempos del outbox, de los arriendos, de `updated_at` y del borrado de archivos los pone la base con
 * `now()` y no pasan por aquí.
 */
export interface Clock {
  now(): Date
}

export const CLOCK = Symbol('CLOCK')
