import { Module } from '@nestjs/common'
import { PayersPersistenceModule } from '#/infrastructure/prisma/repositories/payers/payers-persistence.module.js'
import {
  PAYER_REPOSITORY,
  type PayerRepositoryPort,
} from '#/modules/payers/application/ports/payer-repository.port.js'
import { ListPublicPayersUseCase } from '#/modules/payers/application/use-cases/list-public-payers.use-case.js'
import { PayersController } from '#/modules/payers/presentation/http/controllers/payers.controller.js'

/** Pagadores: `GET /api/v1/payers`. El caso de uso es una clase sin Nest y se cablea aquí. */
@Module({
  imports: [PayersPersistenceModule],
  controllers: [PayersController],
  providers: [
    {
      provide: ListPublicPayersUseCase,
      inject: [PAYER_REPOSITORY],
      useFactory: (payers: PayerRepositoryPort) => new ListPublicPayersUseCase(payers),
    },
  ],
})
export class PayersModule {}
