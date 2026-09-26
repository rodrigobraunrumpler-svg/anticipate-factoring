import { Logger } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppConfigModule } from '#/common/config/index.js'
import { testConfig } from '../../../test/support/config.js'
import { IntakeCapacityMonitor } from './application/services/intake-capacity-monitor.js'
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

const compile = (repository: PayerRepositoryPort, env: Record<string, string> = {}) =>
  Test.createTestingModule({
    imports: [AppConfigModule.register(testConfig(env)), PayersModule],
  })
    .overrideProvider(PAYER_REPOSITORY)
    .useValue(repository)
    .compile()

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PayersModule', () => {
  it('cablea ListPublicPayersUseCase con el repositorio ligado a PAYER_REPOSITORY', async () => {
    const repository: PayerRepositoryPort = { listActive: async () => [sea] }
    const moduleRef = await compile(repository)

    expect(moduleRef.get(PAYER_REPOSITORY)).toBe(repository)
    expect(moduleRef.get(IntakeCapacityMonitor)).toBeInstanceOf(IntakeCapacityMonitor)
    const useCase = moduleRef.get(ListPublicPayersUseCase)
    expect(useCase).toBeInstanceOf(ListPublicPayersUseCase)
    await expect(useCase.execute()).resolves.toEqual([sea])
    await moduleRef.close()
  })

  it('al arrancar revisa los topes de subida contra los pagadores activos, con los de la configuración', async () => {
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    const listActive = vi.fn<PayerRepositoryPort['listActive']>(async () => [
      { ...sea, maxInvoices: 15 },
    ])
    const moduleRef = await compile({ listActive }, { UPLOAD_MAX_FILES: '20' })
    await moduleRef.init()
    // El cierre espera la revisión del arranque: después no queda ninguna consulta en vuelo.
    await moduleRef.close()

    expect(listActive).toHaveBeenCalledTimes(1)
    expect(errors.mock.calls.map(([context]) => context)).toEqual([
      {
        payerId: sea.id,
        slug: 'sea',
        maxInvoices: 15,
        variable: 'UPLOAD_MAX_FILES',
        current: 20,
        required: 30,
      },
    ])
  })

  it('con topes que alcanzan, el arranque no registra errores', async () => {
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    const moduleRef = await compile(
      { listActive: async () => [{ ...sea, maxInvoices: 15 }] },
      {
        UPLOAD_MAX_FILES: '30',
      },
    )
    await moduleRef.init()
    await moduleRef.close()
    expect(errors).not.toHaveBeenCalled()
  })
})
