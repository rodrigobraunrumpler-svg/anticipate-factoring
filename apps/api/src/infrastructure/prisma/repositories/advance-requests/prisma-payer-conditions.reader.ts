import { abortable } from '#/common/utils/abortable.js'
import type { Prisma } from '#/infrastructure/prisma/generated/client.js'
import type { PrismaService } from '#/infrastructure/prisma/prisma.service.js'
import type {
  PayerConditions,
  PayerConditionsReaderPort,
  RepositoryCallOptions,
} from '#/modules/advance-requests/index.js'

/** Solo las columnas que usan las reglas: nada de textos, colores ni logo de la landing. */
const PAYER_CONDITIONS_SELECT = {
  id: true,
  slug: true,
  ruc: true,
  shortName: true,
  advancePercent: true,
  minTermDays: true,
  maxInvoices: true,
  allowedCurrencies: true,
} satisfies Prisma.PayerSelect

type PayerConditionsRow = Prisma.PayerGetPayload<{ select: typeof PAYER_CONDITIONS_SELECT }>

function toPayerConditions(row: PayerConditionsRow): PayerConditions {
  return {
    payerId: row.id,
    slug: row.slug,
    ruc: row.ruc,
    shortName: row.shortName,
    // Decimal(5, 2): 1 a 100 con dos decimales, exacto como number.
    advancePercent: row.advancePercent.toNumber(),
    minTermDays: row.minTermDays,
    maxInvoices: row.maxInvoices,
    allowedCurrencies: [...row.allowedCurrencies],
  }
}

/**
 * Condiciones del pagador activo por su slug (`payers_slug_key`). Un pagador inactivo no existe. Con
 * `signal` cancelada rechaza en el acto (la consulta en curso termina sola y se descarta).
 */
export class PrismaPayerConditionsReader implements PayerConditionsReaderPort {
  constructor(private readonly prisma: PrismaService) {}

  findActiveBySlug(
    slug: string,
    options: RepositoryCallOptions = {},
  ): Promise<PayerConditions | null> {
    return abortable(options.signal, async () => {
      const row = await this.prisma.payer.findUnique({
        where: { slug, active: true },
        select: PAYER_CONDITIONS_SELECT,
      })
      return row === null ? null : toPayerConditions(row)
    })
  }
}
