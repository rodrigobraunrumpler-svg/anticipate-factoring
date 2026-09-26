import { describe, expect, it } from 'vitest'
import { ServiceUnavailableError } from '#/common/exceptions/index.js'
import { translateDatabaseException } from './database-exception.translator.js'
import {
  databaseErrorInfo,
  isDatabaseUnavailableError,
  isUniqueViolation,
  uniqueViolationIndex,
} from './prisma-errors.js'

/** Formas reales de Prisma 7.10 con @prisma/adapter-pg (copiadas de errores del laboratorio). */
function prismaError(code: string, cause: Record<string, unknown>) {
  return Object.assign(new Error('falló'), {
    name: 'PrismaClientKnownRequestError',
    code,
    meta: { modelName: 'Payer', driverAdapterError: { name: 'DriverAdapterError', cause } },
  })
}

const uniqueFromClient = prismaError('P2002', {
  originalCode: '23505',
  originalMessage: 'duplicate key value violates unique constraint "payers_slug_key"',
  kind: 'UniqueConstraintViolation',
  constraint: { index: 'payers_slug_key' },
  table: 'payers',
})
const uniqueFromRawSql = prismaError('P2010', {
  originalCode: '23505',
  originalMessage: 'duplicate key value violates unique constraint "payers_slug_key"',
  kind: 'UniqueConstraintViolation',
  constraint: { index: 'payers_slug_key' },
  table: 'payers',
})
const foreignKey = prismaError('P2003', {
  originalCode: '23503',
  originalMessage:
    'insert or update on table "consents" violates foreign key constraint "consents_advance_request_id_fkey"',
  kind: 'ForeignKeyConstraintViolation',
  constraint: { index: 'consents_advance_request_id_fkey' },
})
const check = prismaError('P2039', {
  originalCode: '23514',
  originalMessage: 'new row for relation "users" violates check constraint "users_full_name_check"',
  kind: 'postgres',
  code: '23514',
  severity: 'ERROR',
  message: 'new row for relation "users" violates check constraint "users_full_name_check"',
  detail:
    'Failing row contains (01a0d754-969e-7b1f-a241-fa15bf71e9ab, ana@proveedor.pe,  , ADMIN).',
})

describe('errores de la base a través de Prisma', () => {
  it('reconoce el índice de una violación de unique del query builder y de SQL crudo', () => {
    expect(uniqueViolationIndex(uniqueFromClient)).toBe('payers_slug_key')
    expect(uniqueViolationIndex(uniqueFromRawSql)).toBe('payers_slug_key')
    expect(isUniqueViolation(uniqueFromClient, 'payers_slug_key')).toBe(true)
    expect(isUniqueViolation(uniqueFromClient, 'payers_ruc_key')).toBe(false)
  })

  it('una FK o un CHECK no son violaciones de unique', () => {
    expect(uniqueViolationIndex(foreignKey)).toBeNull()
    expect(uniqueViolationIndex(check)).toBeNull()
  })

  it('resume el error sin mensaje ni detalle (el detalle de un CHECK copia la fila)', () => {
    expect(databaseErrorInfo(foreignKey)).toEqual({
      prismaCode: 'P2003',
      sqlState: '23503',
      constraint: 'consents_advance_request_id_fkey',
    })
    const info = databaseErrorInfo(check)
    expect(info).toEqual({
      prismaCode: 'P2039',
      sqlState: '23514',
      constraint: 'users_full_name_check',
    })
    expect(JSON.stringify(info)).not.toContain('ana@proveedor.pe')
  })

  it('devuelve null para lo que no es un error conocido de Prisma', () => {
    for (const value of [
      new Error('x'),
      null,
      undefined,
      'P2002',
      { code: 'ECONNREFUSED' },
      { code: 42 },
    ]) {
      expect(databaseErrorInfo(value)).toBeNull()
      expect(uniqueViolationIndex(value)).toBeNull()
    }
  })

  it('un error de Prisma sin causa de la base conserva su código', () => {
    expect(databaseErrorInfo({ code: 'P2028', meta: {} })).toEqual({
      prismaCode: 'P2028',
      sqlState: null,
      constraint: null,
    })
  })
})

/** Error de Prisma 7.10 como lo deja pasar el cliente: la clase, su código y su `meta`. */
function knownError(code: string, message: string, meta: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), {
    name: 'PrismaClientKnownRequestError',
    code,
    clientVersion: '7.10.0',
    meta,
  })
}

const adapterMeta = (cause: Record<string, unknown>, modelName?: string) => ({
  ...(modelName === undefined ? {} : { modelName }),
  driverAdapterError: { name: 'DriverAdapterError', cause },
})

/** Error de `pg` o `pg-pool` que Prisma deja pasar sin envolver (solo le agrega `clientVersion`). */
const pgError = (message: string, options?: ErrorOptions) =>
  Object.assign(new Error(message, options), { clientVersion: '7.10.0' })

const socketError = (code: string) =>
  Object.assign(new Error(`connect ${code} 127.0.0.1:1`), { code, syscall: 'connect', errno: -1 })

describe('isDatabaseUnavailableError', () => {
  // Formas observadas contra PostgreSQL 18 (test/integration/database-unavailable.test.ts las fija).
  it.each([
    [
      'P1001 del query builder (puerto cerrado o host que no resuelve)',
      knownError(
        'P1001',
        'Invalid `prisma.payer.findMany()` invocation',
        adapterMeta({ kind: 'DatabaseNotReachable', host: '127.0.0.1', port: 1 }, 'Payer'),
      ),
    ],
    [
      'P2010 de SQL crudo con la base inalcanzable',
      knownError(
        'P2010',
        "Raw query failed. Code: `N/A`. Message: `Can't reach database server`",
        adapterMeta({ kind: 'DatabaseNotReachable', host: '127.0.0.1', port: 1 }),
      ),
    ],
    [
      'P1000 credenciales rechazadas',
      knownError(
        'P1000',
        'Authentication failed',
        adapterMeta({ kind: 'AuthenticationFailed', originalCode: '28P01' }, 'Payer'),
      ),
    ],
    [
      'P1003 la base no existe',
      knownError(
        'P1003',
        'Database does not exist',
        adapterMeta({ kind: 'DatabaseDoesNotExist', originalCode: '3D000' }, 'Payer'),
      ),
    ],
    [
      'P2010 de SQL crudo con la base inexistente',
      knownError(
        'P2010',
        'Raw query failed. Code: `3D000`.',
        adapterMeta({ kind: 'DatabaseDoesNotExist', originalCode: '3D000' }),
      ),
    ],
    [
      'P1017 el servidor cerró la conexión',
      knownError(
        'P1017',
        'Server has closed the connection.',
        adapterMeta({ kind: 'ConnectionClosed' }),
      ),
    ],
    [
      'P2037 demasiadas conexiones',
      knownError(
        'P2037',
        'Too many database connections opened',
        adapterMeta({ kind: 'TooManyConnections', originalCode: '53300' }),
      ),
    ],
    [
      'P2034 conflicto de escritura o deadlock',
      knownError(
        'P2034',
        'Transaction failed due to a write conflict or a deadlock',
        adapterMeta({ kind: 'TransactionWriteConflict', originalCode: '40P01' }),
      ),
    ],
    [
      'P2024 sin conexión libre en el pool (motor de Rust)',
      knownError('P2024', 'Timed out fetching a new connection'),
    ],
    [
      'P2039 statement_timeout (57014)',
      knownError(
        'P2039',
        'Invalid `tx.payer.findMany()` invocation',
        adapterMeta({ kind: 'postgres', originalCode: '57014', code: '57014' }, 'Payer'),
      ),
    ],
    [
      'P2039 lock_timeout (55P03)',
      knownError(
        'P2039',
        'Invalid `tx.payer.findMany()` invocation',
        adapterMeta({ kind: 'postgres', originalCode: '55P03', code: '55P03' }, 'Payer'),
      ),
    ],
    [
      'P2010 conexión terminada por el administrador (57P01)',
      knownError(
        'P2010',
        'Raw query failed. Code: `57P01`.',
        adapterMeta({ kind: 'postgres', originalCode: '57P01', code: '57P01' }),
      ),
    ],
    [
      'P2039 excepción de conexión (clase 08)',
      knownError(
        'P2039',
        'Database error',
        adapterMeta({ kind: 'postgres', originalCode: '08006' }),
      ),
    ],
    [
      'P2039 recursos insuficientes (clase 53, disco lleno)',
      knownError(
        'P2039',
        'Database error',
        adapterMeta({ kind: 'postgres', originalCode: '53100' }),
      ),
    ],
    [
      'P2028 la transacción no empezó a tiempo (maxWait)',
      knownError(
        'P2028',
        'Transaction API error: Unable to start a transaction in the given time.',
      ),
    ],
    [
      'P2028 la transacción venció (timeout)',
      knownError(
        'P2028',
        'Transaction API error: A commit cannot be executed on an expired transaction.',
        {
          operation: 'commit',
          timeout: 15000,
          timeTaken: 15004,
        },
      ),
    ],
    ['pg-pool sin conexión libre a tiempo', pgError('timeout exceeded when trying to connect')],
    [
      'pg sin respuesta al conectar',
      pgError('Connection terminated due to connection timeout', {
        cause: new Error('Connection terminated unexpectedly'),
      }),
    ],
    ['pg: el servidor cortó la conexión', pgError('Connection terminated unexpectedly')],
    ['pg: el cliente se está cerrando', pgError('Connection terminated')],
    [
      'pg: la conexión de la transacción se cortó',
      pgError('Client has encountered a connection error and is not queryable'),
    ],
    ['pg: el cliente ya se cerró', pgError('Client was closed and is not queryable')],
    [
      'pg-pool cerrado (la API se está apagando)',
      pgError('Cannot use a pool after calling end on the pool'),
    ],
    ['socket: conexión rechazada', socketError('ECONNREFUSED')],
    ['socket: conexión reiniciada', socketError('ECONNRESET')],
    ['socket: DNS sin respuesta', socketError('EAI_AGAIN')],
    [
      'DatabaseError de pg sin el adaptador (57P01)',
      Object.assign(new Error('terminating connection due to administrator command'), {
        code: '57P01',
        severity: 'FATAL',
      }),
    ],
    [
      'la causa de un error que la envuelve',
      new Error('no se pudo leer el pagador', {
        cause: pgError('Connection terminated unexpectedly'),
      }),
    ],
  ])('%s: sí', (_label, error) => {
    expect(isDatabaseUnavailableError(error)).toBe(true)
  })

  it.each([
    ['una violación de unique', uniqueFromClient],
    ['una violación de unique en SQL crudo', uniqueFromRawSql],
    ['una FK', foreignKey],
    ['un CHECK', check],
    [
      'P2028 con una transacción que ya no existe (defecto del código)',
      knownError('P2028', 'Transaction API error: Transaction not found.'),
    ],
    [
      'P2028 con una transacción ya confirmada (defecto del código)',
      knownError(
        'P2028',
        'Transaction API error: Transaction already closed: A query cannot be executed on a committed transaction.',
      ),
    ],
    [
      'P2010 con un tipo que no se puede leer (defecto del código)',
      knownError('P2010', 'Raw query failed.', adapterMeta({ kind: 'UnsupportedNativeDataType' })),
    ],
    [
      'P2039 con un error de sintaxis (42601)',
      knownError(
        'P2039',
        'Database error',
        adapterMeta({ kind: 'postgres', originalCode: '42601' }),
      ),
    ],
    ['P2025 registro inexistente', knownError('P2025', 'No record was found')],
    [
      'DatabaseError de pg sin el adaptador (23505)',
      Object.assign(new Error('duplicate key'), { code: '23505', severity: 'ERROR' }),
    ],
    ['un error cualquiera', new Error('boom')],
    ['un mensaje de pg con texto de más', pgError('Connection terminated unexpectedly: x')],
    ['un código de socket sin syscall', Object.assign(new Error('x'), { code: 'ECONNREFUSED' })],
    ['un texto', 'Connection terminated unexpectedly'],
    ['null', null],
    ['undefined', undefined],
  ])('%s: no', (_label, error) => {
    expect(isDatabaseUnavailableError(error)).toBe(false)
  })

  it('una causa circular no lo cuelga', () => {
    const first = new Error('uno')
    const second = new Error('dos', { cause: first })
    Object.assign(first, { cause: second })
    expect(isDatabaseUnavailableError(first)).toBe(false)
  })
})

describe('translateDatabaseException', () => {
  it('traduce la base no disponible a ServiceUnavailableError con el error original como causa', () => {
    const original = pgError('timeout exceeded when trying to connect')
    const translated = translateDatabaseException(original)
    expect(translated).toBeInstanceOf(ServiceUnavailableError)
    expect(translated?.publicCode).toBe('SERVICE_UNAVAILABLE')
    expect(translated?.cause).toBe(original)
  })

  it('no traduce lo que no reconoce: un defecto del código sigue siendo 500', () => {
    expect(translateDatabaseException(uniqueFromClient)).toBeUndefined()
    expect(translateDatabaseException(new Error('boom'))).toBeUndefined()
  })
})
