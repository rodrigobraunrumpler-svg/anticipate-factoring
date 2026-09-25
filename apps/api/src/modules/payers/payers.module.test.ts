import { Test } from '@nestjs/testing'
import { describe, expect, it } from 'vitest'
import { ListPublicPayersUseCase } from './application/use-cases/list-public-payers.use-case.js'
import { PAYER_REPOSITORY, type Payer, type PayerRepositoryPort } from './index.js'
import { PayersModule } from './payers.module.js'

const sea: Payer = {
  id: '01890a5d-ac96-774b-bcce-b302099a8057',
  slug: 'sea',
  ruc: '20131312955',
  legalName: 'Servicios Energéticos Ambientales S.A.',
  shortName: 'SEA',
  advancePercent: 80,
  minTermDays: 15,
  maxInvoices: 10,
  allowedCurrencies: ['PEN', 'USD'],
  accentColor: '#0E7C86',
  logoUrl: null,
  texts: { title: 'Adelanta tus facturas a SEA' },
}

describe('PayersModule', () => {
  it('cablea ListPublicPayersUseCase con el repositorio ligado a PAYER_REPOSITORY', async () => {
    const repository: PayerRepositoryPort = { listActive: async () => [sea] }
    const moduleRef = await Test.createTestingModule({ imports: [PayersModule] })
      .overrideProvider(PAYER_REPOSITORY)
      .useValue(repository)
      .compile()

    expect(moduleRef.get(PAYER_REPOSITORY)).toBe(repository)
    const useCase = moduleRef.get(ListPublicPayersUseCase)
    expect(useCase).toBeInstanceOf(ListPublicPayersUseCase)
    await expect(useCase.execute()).resolves.toEqual([sea])
    await moduleRef.close()
  })
})
