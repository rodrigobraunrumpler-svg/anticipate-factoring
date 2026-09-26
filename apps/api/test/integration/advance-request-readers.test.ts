import { Test, type TestingModule } from '@nestjs/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AppConfigModule } from '#/common/config/index.js'
import { PrismaModule } from '#/infrastructure/prisma/prisma.module.js'
import { PrismaService } from '#/infrastructure/prisma/prisma.service.js'
import { PrismaLegalDocumentReader } from '#/infrastructure/prisma/repositories/advance-requests/prisma-legal-document.reader.js'
import { PrismaPayerConditionsReader } from '#/infrastructure/prisma/repositories/advance-requests/prisma-payer-conditions.reader.js'
import {
  LEGAL_DOCUMENT_READER,
  type LegalDocumentReaderPort,
  PAYER_CONDITIONS_READER,
  type PayerConditionsReaderPort,
} from '#/modules/advance-requests/index.js'
import { testConfig } from '../support/config.js'
import { createTestPrisma, truncateAll } from '../support/db.js'
import { createPayer, SEA } from '../support/factories.js'

const db = createTestPrisma()
let moduleRef: TestingModule
let payers: PayerConditionsReaderPort
let legalDocuments: LegalDocumentReaderPort

/** Versión de prueba con todas las columnas explícitas; `truncateAll` la borra entre tests. */
const legalVersion = (
  type: 'TERMS' | 'PERSONAL_DATA',
  version: string,
  retiredAt: Date | null,
) => ({
  type,
  version,
  url: `https://anticipate.pe/legal/${type.toLowerCase()}/${version}`,
  sha256: 'c'.repeat(64),
  publishedAt: new Date('2026-08-01T00:00:00.000Z'),
  retiredAt,
})

beforeAll(async () => {
  // Mismo cableado que hará AdvanceRequestsPersistenceModule (Tarea 12): useFactory + inject.
  moduleRef = await Test.createTestingModule({
    imports: [AppConfigModule.register(testConfig()), PrismaModule],
    providers: [
      {
        provide: PAYER_CONDITIONS_READER,
        inject: [PrismaService],
        useFactory: (prisma: PrismaService) => new PrismaPayerConditionsReader(prisma),
      },
      {
        provide: LEGAL_DOCUMENT_READER,
        inject: [PrismaService],
        useFactory: (prisma: PrismaService) => new PrismaLegalDocumentReader(prisma),
      },
    ],
  }).compile()
  await moduleRef.init()
  payers = moduleRef.get(PAYER_CONDITIONS_READER)
  legalDocuments = moduleRef.get(LEGAL_DOCUMENT_READER)
})

beforeEach(async () => {
  await truncateAll(db.prisma)
})

afterAll(async () => {
  await moduleRef.close()
  await db.close()
})

describe('PrismaPayerConditionsReader', () => {
  it('devuelve las condiciones del pagador activo con números y monedas del dominio', async () => {
    const payer = await createPayer(db.prisma)
    await expect(payers.findActiveBySlug(SEA.slug)).resolves.toEqual({
      payerId: payer.id,
      slug: SEA.slug,
      ruc: SEA.ruc,
      shortName: SEA.shortName,
      advancePercent: Number(SEA.advancePercent),
      minTermDays: SEA.minTermDays,
      maxInvoices: SEA.maxInvoices,
      allowedCurrencies: SEA.allowedCurrencies,
    })
  })

  it('conserva los decimales del porcentaje de adelanto', async () => {
    await createPayer(db.prisma, { advancePercent: '72.50' })
    const conditions = await payers.findActiveBySlug(SEA.slug)
    expect(conditions?.advancePercent).toBe(72.5)
  })

  it('un pagador inactivo o un slug desconocido no tienen condiciones', async () => {
    await createPayer(db.prisma, { active: false })
    await expect(payers.findActiveBySlug(SEA.slug)).resolves.toBeNull()
    await expect(payers.findActiveBySlug('no-existe')).resolves.toBeNull()
  })
})

describe('PrismaLegalDocumentReader', () => {
  it('una versión publicada y sin retirar está vigente', async () => {
    await db.prisma.legalDocumentVersion.createMany({
      data: [
        legalVersion('TERMS', 'it-vigente', null),
        legalVersion('PERSONAL_DATA', 'it-vigente', null),
      ],
    })
    await expect(legalDocuments.isCurrent('TERMS', 'it-vigente')).resolves.toBe(true)
    await expect(legalDocuments.isCurrent('PERSONAL_DATA', 'it-vigente')).resolves.toBe(true)
  })

  it('una versión retirada ya no está vigente', async () => {
    await db.prisma.legalDocumentVersion.create({
      data: legalVersion('TERMS', 'it-retirada', new Date('2026-09-01T00:00:00.000Z')),
    })
    await expect(legalDocuments.isCurrent('TERMS', 'it-retirada')).resolves.toBe(false)
  })

  it('una versión que no existe, o que existe solo para el otro documento, no está vigente', async () => {
    await db.prisma.legalDocumentVersion.create({
      data: legalVersion('TERMS', 'it-solo-terminos', null),
    })
    await expect(legalDocuments.isCurrent('TERMS', 'it-no-existe')).resolves.toBe(false)
    await expect(legalDocuments.isCurrent('PERSONAL_DATA', 'it-solo-terminos')).resolves.toBe(false)
  })
})
