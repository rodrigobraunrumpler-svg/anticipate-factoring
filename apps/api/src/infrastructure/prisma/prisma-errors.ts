/** SQLSTATE de PostgreSQL que la API distingue. */
export const SQL_STATE = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  notNullViolation: '23502',
  exclusionViolation: '23P01',
  serializationFailure: '40001',
  deadlockDetected: '40P01',
  lockNotAvailable: '55P03',
  queryCanceled: '57014',
} as const

/**
 * Lo que se puede saber, sin datos personales, de un error de la base que pasó por Prisma 7 con
 * `@prisma/adapter-pg`. Prisma deja la causa en `meta.driverAdapterError.cause`: el nombre del índice
 * en `constraint.index` (unique y FK), nunca en `meta.target`. Un CHECK solo trae su nombre dentro
 * del mensaje, y su `detail` copia la fila entera: por eso esto nunca devuelve `message` ni `detail`,
 * y los logs registran este resumen en vez del error crudo.
 */
export type DatabaseErrorInfo = {
  /** P2002 (unique), P2003 (FK), P2010 (SQL crudo), P2039 (CHECK) u otro. */
  prismaCode: string
  /** SQLSTATE de PostgreSQL, o `null` si el error no vino de la base. */
  sqlState: string | null
  /** Índice o restricción que falló, o `null` si la base no lo informa. */
  constraint: string | null
}

type UnknownRecord = Record<string, unknown>

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const CONSTRAINT_IN_MESSAGE = /constraint "([^"]+)"/

/** Resumen seguro de un error conocido de Prisma, o `null` si `error` no es uno. */
export function databaseErrorInfo(error: unknown): DatabaseErrorInfo | null {
  if (!isRecord(error)) return null
  const prismaCode = text(error.code)
  if (prismaCode === null || !/^P\d{4}$/.test(prismaCode)) return null
  const meta = isRecord(error.meta) ? error.meta : {}
  const adapterError = isRecord(meta.driverAdapterError) ? meta.driverAdapterError : {}
  const cause = isRecord(adapterError.cause) ? adapterError.cause : {}
  const sqlState = text(cause.originalCode) ?? text(cause.code)
  const fromIndex = isRecord(cause.constraint) ? text(cause.constraint.index) : null
  const fromMessage = CONSTRAINT_IN_MESSAGE.exec(text(cause.originalMessage) ?? '')?.[1] ?? null
  return { prismaCode, sqlState, constraint: fromIndex ?? fromMessage }
}

/** Índice único que violó el error (con el query builder o con SQL crudo), o `null`. */
export function uniqueViolationIndex(error: unknown): string | null {
  const info = databaseErrorInfo(error)
  return info?.sqlState === SQL_STATE.uniqueViolation ? info.constraint : null
}

/** ¿El error es una violación del índice único `indexName`? */
export function isUniqueViolation(error: unknown, indexName: string): boolean {
  return uniqueViolationIndex(error) === indexName
}
