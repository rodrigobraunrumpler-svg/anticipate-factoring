import { Inject, Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '#/infrastructure/prisma/prisma.service.js'
import type { Payer, PayerRepositoryPort } from '#/modules/payers/index.js'
import { PAYER_ROW_SELECT, toPayer } from './mappers/payer-row.mapper.js'

/** Implementación Prisma de `PayerRepositoryPort`, ligada a `PAYER_REPOSITORY` en `PayersPersistenceModule`. */
@Injectable()
export class PrismaPayerRepository implements PayerRepositoryPort {
  private readonly logger = new Logger(PrismaPayerRepository.name)

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async listActive(): Promise<Payer[]> {
    // Sin índice sobre `active`: son pocas filas y el escaneo secuencial es lo más barato.
    const rows = await this.prisma.payer.findMany({
      where: { active: true },
      select: PAYER_ROW_SELECT,
      orderBy: [{ shortName: 'asc' }, { id: 'asc' }],
    })
    const payers: Payer[] = []
    for (const row of rows) {
      const mapped = toPayer(row)
      if (mapped.ok) {
        payers.push(mapped.payer)
      } else {
        this.logger.error(
          { payerId: row.id, slug: row.slug, reason: mapped.reason },
          'Pagador activo omitido: su fila no se puede leer',
        )
      }
    }
    return payers
  }
}
