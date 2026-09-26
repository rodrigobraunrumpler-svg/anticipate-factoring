import type { IntakeLimits } from '@anticipate/shared/api'
import { Controller, Get, Inject, Res } from '@nestjs/common'
import type { Response } from 'express'
import { APP_CONFIG, type AppConfig } from '#/common/config/index.js'
import { INTAKE_LIMITS_CACHE_CONTROL } from '#/modules/advance-requests/presentation/http/constants/intake-limits.constants.js'
import { toIntakeLimits } from '#/modules/advance-requests/presentation/http/mappers/intake-limits.mapper.js'
import { AdvanceRequestsApiTags } from '#/modules/advance-requests/presentation/http/swagger/advance-requests.swagger.js'
import { ApiIntakeLimitsDocs } from '#/modules/advance-requests/presentation/http/swagger/intake-limits.swagger.js'

/**
 * Topes de subida para la landing (`GET /api/v1/intake-limits`). Controlador aparte del de
 * `POST /api/v1/advance-requests`: el tope por `Content-Length` se aplica a ese controlador y no a
 * esta lectura. Los topes salen de la configuración validada al arrancar y no cambian en la vida del
 * proceso, así que se calculan una vez.
 */
@AdvanceRequestsApiTags()
@Controller({ path: 'intake-limits', version: '1' })
export class IntakeLimitsController {
  private readonly limits: IntakeLimits

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.limits = toIntakeLimits(config.upload)
  }

  /** La cabecera de caché se pone solo al responder bien, como en `GET /api/v1/payers`. */
  @Get()
  @ApiIntakeLimitsDocs()
  get(@Res({ passthrough: true }) res: Response): IntakeLimits {
    res.setHeader('Cache-Control', INTAKE_LIMITS_CACHE_CONTROL)
    return this.limits
  }
}
