import type { IntakeLimits } from '@anticipate/shared/api'
import { submissionBodyBytesUpperBound } from '@anticipate/shared/api'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Payer } from '#/modules/payers/domain/types/payer.js'
import type { PayerRepositoryPort } from '../ports/payer-repository.port.js'
import { type IntakeCapacityLogger, IntakeCapacityMonitor } from './intake-capacity-monitor.js'

const LIMITS: IntakeLimits = {
  maxFiles: 20,
  maxXmlBytes: 1_048_576,
  maxPdfBytes: 10_485_760,
  maxBodyBytes: 95_000_000,
}

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
  texts: {},
}
const agro: Payer = {
  ...sea,
  id: '01890a5d-ac96-774b-bcce-b302099a8058',
  slug: 'agro',
  maxInvoices: 15,
}

function recordingLogger() {
  return {
    log: vi.fn<IntakeCapacityLogger['log']>(),
    warn: vi.fn<IntakeCapacityLogger['warn']>(),
    error: vi.fn<IntakeCapacityLogger['error']>(),
  }
}

let logger: ReturnType<typeof recordingLogger>
let listActive: ReturnType<typeof vi.fn<PayerRepositoryPort['listActive']>>

beforeEach(() => {
  logger = recordingLogger()
  listActive = vi.fn<PayerRepositoryPort['listActive']>(async () => [sea, agro])
})

const monitor = (limits: IntakeLimits = LIMITS) =>
  new IntakeCapacityMonitor(limits, { listActive }, logger)

describe('IntakeCapacityMonitor.review', () => {
  it('un pagador cuyo máximo entra en los topes no deja rastro', () => {
    expect(monitor().review([sea])).toEqual([])
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('con más facturas que UPLOAD_MAX_FILES / 2, registra un error con el pagador y la variable a subir', () => {
    const conflicts = monitor().review([sea, agro])
    const expected = {
      payerId: agro.id,
      slug: 'agro',
      maxInvoices: 15,
      variable: 'UPLOAD_MAX_FILES',
      current: 20,
      required: 30,
    }
    expect(conflicts).toEqual([expected])
    expect(logger.error).toHaveBeenCalledTimes(1)
    const [context, message] = logger.error.mock.calls[0] ?? []
    expect(context).toEqual(expected)
    expect(message).toContain('UPLOAD_MAX_FILES')
    expect(message).toContain('30')
    expect(message).toContain('max_invoices')
    expect(message).toContain('TOO_MANY_FILES')
    expect(message).toContain('agro')
  })

  it('con un cuerpo que no alcanza para los XML del máximo, nombra UPLOAD_MAX_BODY_BYTES', () => {
    const huge: Payer = { ...agro, slug: 'huge', maxInvoices: 100 }
    const required = submissionBodyBytesUpperBound([
      ...Array<number>(100).fill(LIMITS.maxXmlBytes),
      ...Array<number>(100).fill(0),
    ])
    const conflicts = monitor({ ...LIMITS, maxFiles: 200 }).review([huge])
    expect(conflicts).toEqual([
      {
        payerId: huge.id,
        slug: 'huge',
        maxInvoices: 100,
        variable: 'UPLOAD_MAX_BODY_BYTES',
        current: 95_000_000,
        required,
      },
    ])
    const [, message] = logger.error.mock.calls[0] ?? []
    expect(message).toContain('UPLOAD_MAX_BODY_BYTES')
    expect(message).toContain('UPLOAD_MAX_INFLIGHT_BYTES')
    expect(message).toContain('PAYLOAD_TOO_LARGE')
  })

  it('registra cada conflicto una vez por proceso, pero lo devuelve siempre', () => {
    const watcher = monitor()
    expect(watcher.review([agro])).toHaveLength(1)
    expect(watcher.review([agro])).toHaveLength(1)
    expect(logger.error).toHaveBeenCalledTimes(1)
    // Otro máximo del mismo pagador (lo cambiaron en la base sin desplegar) es otro problema.
    watcher.review([{ ...agro, maxInvoices: 16 }])
    expect(logger.error).toHaveBeenCalledTimes(2)
  })

  it('un máximo que no es un entero positivo no lo juzga ni lanza: lo registra la lista pública', () => {
    expect(
      monitor().review([
        { ...agro, maxInvoices: 0 },
        { ...agro, maxInvoices: 2.5 },
      ]),
    ).toEqual([])
    expect(logger.error).not.toHaveBeenCalled()
  })
})

describe('IntakeCapacityMonitor.reviewActivePayers', () => {
  it('revisa los pagadores activos y deja un resumen', async () => {
    await monitor().reviewActivePayers()
    expect(listActive).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.log).toHaveBeenCalledWith(
      { activePayers: 2, conflicts: 1 },
      expect.stringContaining('Topes de subida revisados'),
    )
  })

  it('si la base no responde, lo avisa y no rechaza: la revisión sigue con GET /api/v1/payers', async () => {
    const failure = new Error('la base no responde')
    listActive.mockRejectedValueOnce(failure)
    await expect(monitor().reviewActivePayers()).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith(
      { err: failure },
      expect.stringContaining('GET /api/v1/payers'),
    )
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('tampoco rechaza si el repositorio devuelve algo que no es una lista: una promesa suelta tumbaría el proceso', async () => {
    listActive.mockResolvedValueOnce(undefined as unknown as Payer[])
    await expect(monitor().reviewActivePayers()).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })
})
