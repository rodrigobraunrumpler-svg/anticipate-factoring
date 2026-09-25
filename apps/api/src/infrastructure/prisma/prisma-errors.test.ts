import { describe, expect, it } from 'vitest'
import { databaseErrorInfo, isUniqueViolation, uniqueViolationIndex } from './prisma-errors.js'

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
