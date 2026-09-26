import type { PublicPayer } from '@anticipate/shared/payer'
import { Controller, Get, Inject, Logger, Res } from '@nestjs/common'
import { ApiTags } from '@nestjs/swagger'
import type { Response } from 'express'
import { apiError } from '#/common/exceptions/index.js'
import { ListPublicPayersUseCase } from '#/modules/payers/application/use-cases/list-public-payers.use-case.js'
import { PUBLIC_PAYERS_CACHE_CONTROL } from '../constants/public-payers.constants.js'
import { toPublicPayers } from '../mappers/public-payer.mapper.js'
import { ApiListPublicPayersDocs } from '../swagger/payers.swagger.js'

@ApiTags('payers')
@Controller({ path: 'payers', version: '1' })
export class PayersController {
  private readonly logger = new Logger(PayersController.name)

  constructor(
    @Inject(ListPublicPayersUseCase) private readonly listPublicPayers: ListPublicPayersUseCase,
  ) {}

  /**
   * Pagadores activos para la landing. La cabecera de caché se pone solo al responder bien: un error
   * nunca queda guardado en la CDN como si fuera la lista. Si hay activos y ninguno cumple el
   * contrato público, responde 500: una lista vacía cacheable publicaría una landing sin pagadores.
   */
  @Get()
  @ApiListPublicPayersDocs()
  async list(@Res({ passthrough: true }) res: Response): Promise<PublicPayer[]> {
    const { payers, rejected } = toPublicPayers(await this.listPublicPayers.execute())
    for (const payer of rejected) {
      this.logger.error(
        { payerId: payer.id, slug: payer.slug, issues: payer.issues },
        'Pagador omitido de la lista pública: no cumple publicPayerSchema',
      )
    }
    if (payers.length === 0 && rejected.length > 0) {
      throw apiError(
        'INTERNAL_ERROR',
        `Ninguno de los ${rejected.length} pagadores activos cumple publicPayerSchema`,
      )
    }
    res.setHeader('Cache-Control', PUBLIC_PAYERS_CACHE_CONTROL)
    return payers
  }
}
