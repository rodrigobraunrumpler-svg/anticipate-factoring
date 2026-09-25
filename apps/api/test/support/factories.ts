import { createHash } from 'node:crypto'
import type { Currency } from '@anticipate/shared/money'
import type { PrismaService } from '#/infrastructure/prisma/index.js'

/**
 * Pagador de prueba. Cumple `publicPayerSchema` y todas las CHECK de `payers` (RUC válido, slug,
 * color, largos y textos), así que sirve igual antes y después de la migración `integrity`.
 */
export const SEA = {
  slug: 'sea',
  ruc: '20131312955',
  legalName: 'Servicios Energéticos Ambientales S.A.',
  shortName: 'SEA',
  advancePercent: '80.00',
  minTermDays: 15,
  maxInvoices: 10,
  allowedCurrencies: ['PEN', 'USD'] as Currency[],
  accentColor: '#0E7C86',
  logoUrl: null as string | null,
  texts: { title: 'Adelanta tus facturas a SEA' } as Record<string, string>,
}

export type PayerOverrides = Partial<typeof SEA> & { active?: boolean }

export const createPayer = (prisma: PrismaService, overrides: PayerOverrides = {}) =>
  prisma.payer.create({ data: { ...SEA, ...overrides } })

/** Proveedor de prueba: RUC válido (módulo 11) y razón social no vacía. */
export const TEST_SUPPLIER = { ruc: '20100070970', legalName: 'PROVEEDOR EJEMPLO S.A.C.' }

export const createSupplier = (prisma: PrismaService, ruc: string = TEST_SUPPLIER.ruc) =>
  prisma.supplier.create({ data: { ruc, legalName: TEST_SUPPLIER.legalName } })

/** Versión que envía el formulario de prueba en `termsVersion` y `privacyVersion`. */
export const TEST_LEGAL_VERSION = '2026-09'

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

/** Versiones legales vigentes de los tests. `truncateAll` las vuelve a insertar. */
export const TEST_LEGAL_DOCUMENT_VERSIONS = [
  {
    type: 'TERMS' as const,
    version: TEST_LEGAL_VERSION,
    url: 'https://anticipate.test/legal/terminos/2026-09',
    sha256: sha256('Términos y condiciones de prueba 2026-09'),
    publishedAt: new Date('2026-09-01T05:00:00.000Z'),
    retiredAt: null as Date | null,
  },
  {
    type: 'PERSONAL_DATA' as const,
    version: TEST_LEGAL_VERSION,
    url: 'https://anticipate.test/legal/datos-personales/2026-09',
    sha256: sha256('Política de datos personales de prueba 2026-09'),
    publishedAt: new Date('2026-09-01T05:00:00.000Z'),
    retiredAt: null as Date | null,
  },
]

export type LegalDocumentVersionInput = (typeof TEST_LEGAL_DOCUMENT_VERSIONS)[number]

/** Inserta versiones legales sin pisar las que ya existen. Devuelve cuántas insertó. */
export async function createLegalDocumentVersions(
  prisma: PrismaService,
  versions: readonly LegalDocumentVersionInput[] = TEST_LEGAL_DOCUMENT_VERSIONS,
): Promise<number> {
  const result = await prisma.legalDocumentVersion.createMany({
    data: [...versions],
    skipDuplicates: true,
  })
  return result.count
}
