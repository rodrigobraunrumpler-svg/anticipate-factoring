import { Global, Module } from '@nestjs/common'
import { APP_CONFIG, type AppConfig } from '#/common/config/index.js'
import { INFLIGHT_BODY_BUDGET, InflightBodyBudget } from './inflight-body-budget.js'

/**
 * Un solo presupuesto de cuerpos en memoria por proceso (`INFLIGHT_BODY_BUDGET`), compartido por toda
 * ruta que lee un multipart con `MultipartFilesInterceptor`.
 */
@Global()
@Module({
  providers: [
    {
      provide: INFLIGHT_BODY_BUDGET,
      inject: [APP_CONFIG],
      useFactory: ({ upload }: AppConfig) => new InflightBodyBudget(upload.maxInflightBytes),
    },
  ],
  exports: [INFLIGHT_BODY_BUDGET],
})
export class InflightBodyBudgetModule {}
