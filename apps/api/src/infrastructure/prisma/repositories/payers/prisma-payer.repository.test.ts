import { Logger } from '@nestjs/common'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '#/infrastructure/prisma/generated/client.js'
import type { PrismaService } from '#/infrastructure/prisma/prisma.service.js'
import { PAYER_ROW_SELECT, type PayerRow } from './mappers/payer-row.mapper.js'
import { PrismaPayerRepository } from './prisma-payer.repository.js'

const row = (overrides: Partial<PayerRow> = {}): PayerRow => ({
  id: '01890a5d-ac96-774b-bcce-b302099a8057',
  slug: 'sea',
  ruc: '20131312955',
  legalName: 'Servicios Energéticos Ambientales S.A.',
  shortName: 'SEA',
  advancePercent: new Prisma.Decimal('80'),
  minTermDays: 15,
  maxInvoices: 10,
  allowedCurrencies: ['PEN', 'USD'],
  accentColor: '#0E7C86',
  logoUrl: null,
  texts: { title: 'Adelanta tus facturas a SEA' },
  ...overrides,
})

function repositoryWith(rows: PayerRow[]) {
  const findMany = vi.fn(async (_args: unknown) => rows)
  const prisma = { payer: { findMany } } as unknown as PrismaService
  return { repository: new PrismaPayerRepository(prisma), findMany }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PrismaPayerRepository.listActive', () => {
  it('consulta solo los activos, con la proyección de Payer y orden estable', async () => {
    const { repository, findMany } = repositoryWith([])
    await repository.listActive()
    expect(findMany).toHaveBeenCalledWith({
      where: { active: true },
      select: PAYER_ROW_SELECT,
      orderBy: [{ shortName: 'asc' }, { id: 'asc' }],
    })
  })

  it('omite y registra con nivel error la fila que no se puede leer, sin perder las demás', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const broken = row({ id: '01890a5d-ac96-774b-bcce-b302099a8058', slug: 'rota', texts: 'hola' })
    const agro = row({
      id: '01890a5d-ac96-774b-bcce-b302099a8059',
      slug: 'agro-andina',
      shortName: 'Agro Andina',
    })
    const { repository } = repositoryWith([agro, broken, row()])

    const payers = await repository.listActive()

    expect(payers.map((payer) => payer.slug)).toEqual(['agro-andina', 'sea'])
    expect(error).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(
      { payerId: broken.id, slug: 'rota', reason: 'texts no es un objeto JSON' },
      'Pagador activo omitido: su fila no se puede leer',
    )
  })

  it('si hay activos y ninguna fila se puede leer, lanza: una lista vacía diría que no hay pagadores', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const { repository } = repositoryWith([
      row({ texts: 'hola' }),
      row({ id: '01890a5d-ac96-774b-bcce-b302099a8058', slug: 'rota', texts: [1] }),
    ])

    await expect(repository.listActive()).rejects.toThrow(
      'Hay 2 pagadores activos y ninguna de sus filas se puede leer',
    )
    expect(error).toHaveBeenCalledTimes(2)
  })

  it('sin pagadores activos devuelve la lista vacía', async () => {
    const { repository } = repositoryWith([])
    await expect(repository.listActive()).resolves.toEqual([])
  })
})
