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
  idleInTransactionSessionTimeout: '25P03',
  systemError: '58000',
  ioError: '58030',
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

/**
 * Códigos de Prisma de una base que no está disponible: no se llega (P1001, P1002, P1008, P1011), no
 * deja entrar (P1000, P1003, P1010), cortó la conexión (P1017), no hay conexiones libres (P2024 del
 * motor de Rust, P2037) o la transacción chocó con otra y conviene reintentar (P2034).
 */
const UNAVAILABLE_PRISMA_CODES: ReadonlySet<string> = new Set([
  'P1000',
  'P1001',
  'P1002',
  'P1003',
  'P1008',
  'P1010',
  'P1011',
  'P1017',
  'P2024',
  'P2034',
  'P2037',
])

/**
 * Los mismos casos como `kind` del `DriverAdapterError`. Hace falta porque el SQL crudo envuelve todo
 * error de la base en P2010 (`Raw query failed`) y solo la causa dice que la base no respondió.
 */
const UNAVAILABLE_ADAPTER_KINDS: ReadonlySet<string> = new Set([
  'AuthenticationFailed',
  'DatabaseNotReachable',
  'DatabaseDoesNotExist',
  'SocketTimeout',
  'DatabaseAccessDenied',
  'TlsConnectionError',
  'ConnectionClosed',
  'TransactionWriteConflict',
  'TooManyConnections',
])

/**
 * SQLSTATE sueltos de una base que no puede atender ahora: `statement_timeout`, `lock_timeout`,
 * `idle_in_transaction_session_timeout`, serialización o deadlock, y fallas de E/S del servidor. Las
 * clases enteras están en `isUnavailableSqlState`.
 */
const UNAVAILABLE_SQL_STATES: ReadonlySet<string> = new Set([
  SQL_STATE.queryCanceled,
  SQL_STATE.lockNotAvailable,
  SQL_STATE.idleInTransactionSessionTimeout,
  SQL_STATE.serializationFailure,
  SQL_STATE.deadlockDetected,
  SQL_STATE.systemError,
  SQL_STATE.ioError,
])

/** Clase 08 (conexión), 53 (recursos: conexiones, disco, memoria) y 57P (apagado, reinicio). */
function isUnavailableSqlState(sqlState: string): boolean {
  return (
    sqlState.startsWith('08') ||
    sqlState.startsWith('53') ||
    sqlState.startsWith('57P') ||
    UNAVAILABLE_SQL_STATES.has(sqlState)
  )
}

/**
 * Mensajes fijos de `pg` y `pg-pool` cuando se cae o se agota la conexión. `@prisma/adapter-pg` no los
 * convierte (no traen código) y Prisma los deja pasar como `Error`: el mensaje es lo único que los
 * distingue. Son textos de la librería, sin datos de la consulta.
 */
const PG_CONNECTION_ERROR_MESSAGES: ReadonlySet<string> = new Set([
  'Connection terminated unexpectedly',
  'Connection terminated',
  'Connection terminated due to connection timeout',
  'timeout exceeded when trying to connect',
  'timeout expired',
  'Client has encountered a connection error and is not queryable',
  'Client was closed and is not queryable',
  'Cannot use a pool after calling end on the pool',
])

/** Errores de socket de Node que significan que el servidor no se alcanzó o cortó la conexión. */
const SOCKET_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
])

/** Profundidad máxima de `cause` que se recorre: evita ciclos y cadenas absurdas. */
const MAX_CAUSE_DEPTH = 5

/**
 * P2028 es 503 solo si la transacción no empezó a tiempo (`maxWait`, pool agotado) o venció
 * (`timeout`). Sus demás variantes (transacción inexistente, ya cerrada, nivel de aislamiento
 * inválido) son defectos del código y siguen siendo 500.
 */
function isTransactionTimeout(error: UnknownRecord, meta: UnknownRecord): boolean {
  if (typeof meta.timeout === 'number' && typeof meta.timeTaken === 'number') return true
  return text(error.message)?.includes('Unable to start a transaction in the given time') === true
}

function isUnavailable(error: UnknownRecord): boolean {
  const code = text(error.code)
  if (code !== null && /^P\d{4}$/.test(code)) {
    if (UNAVAILABLE_PRISMA_CODES.has(code)) return true
    const meta = isRecord(error.meta) ? error.meta : {}
    if (code === 'P2028') return isTransactionTimeout(error, meta)
    const adapterError = isRecord(meta.driverAdapterError) ? meta.driverAdapterError : {}
    const cause = isRecord(adapterError.cause) ? adapterError.cause : {}
    const kind = text(cause.kind)
    if (kind !== null && UNAVAILABLE_ADAPTER_KINDS.has(kind)) return true
    const sqlState = text(cause.originalCode) ?? text(cause.code)
    return sqlState !== null && isUnavailableSqlState(sqlState)
  }
  if (code !== null && typeof error.syscall === 'string') return SOCKET_ERROR_CODES.has(code)
  // `DatabaseError` de `pg` sin pasar por el adaptador (lo usaría una consulta directa al pool).
  if (code !== null && typeof error.severity === 'string') return isUnavailableSqlState(code)
  return error instanceof Error && PG_CONNECTION_ERROR_MESSAGES.has(error.message)
}

/**
 * ¿`error` dice que la base no está disponible (caída, inalcanzable, sin conexiones libres, apagándose
 * o demasiado lenta), y no que la consulta tenga un defecto? Reconoce los errores de Prisma 7 con
 * `@prisma/adapter-pg` (por código, por `kind` del adaptador o por SQLSTATE), los de `pg` y `pg-pool`
 * que Prisma deja pasar sin envolver y los de socket de Node, también como `cause` de otro error. Las
 * formas reales las fija `test/integration/database-unavailable.test.ts`.
 */
export function isDatabaseUnavailableError(error: unknown): boolean {
  const seen = new Set<unknown>()
  let current: unknown = error
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && isRecord(current); depth++) {
    if (seen.has(current)) return false
    seen.add(current)
    if (isUnavailable(current)) return true
    current = current.cause
  }
  return false
}
