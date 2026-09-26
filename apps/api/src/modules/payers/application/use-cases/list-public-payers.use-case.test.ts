import { describe, expect, it, vi } from 'vitest'
import type { Payer } from '#/modules/payers/domain/types/payer.js'
import type { PayerRepositoryPort } from '../ports/payer-repository.port.js'
import type { IntakeCapacityMonitor } from '../services/intake-capacity-monitor.js'
import { ListPublicPayersUseCase } from './list-public-payers.use-case.js'

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

const capacity = () => ({ review: vi.fn<IntakeCapacityMonitor['review']>(() => []) })

describe('ListPublicPayersUseCase', () => {
  it('devuelve los pagadores activos que da el repositorio, en su orden', async () => {
    const listActive = vi.fn<PayerRepositoryPort['listActive']>(async () => [sea])
    const useCase = new ListPublicPayersUseCase({ listActive }, capacity())
    await expect(useCase.execute()).resolves.toEqual([sea])
    expect(listActive).toHaveBeenCalledTimes(1)
  })

  it('revisa los topes de subida contra los pagadores que sirve', async () => {
    const monitor = capacity()
    const useCase = new ListPublicPayersUseCase({ listActive: async () => [sea] }, monitor)
    await useCase.execute()
    expect(monitor.review).toHaveBeenCalledWith([sea])
  })

  it('deja pasar el error del repositorio: el filtro global lo convierte en el sobre de error', async () => {
    const failure = new Error('la base no responde')
    const monitor = capacity()
    const useCase = new ListPublicPayersUseCase(
      { listActive: async () => Promise.reject(failure) },
      monitor,
    )
    await expect(useCase.execute()).rejects.toBe(failure)
    expect(monitor.review).not.toHaveBeenCalled()
  })
})
