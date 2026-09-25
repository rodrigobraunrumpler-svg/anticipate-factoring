import { Module } from '@nestjs/common'
import { PAYER_REPOSITORY } from '#/modules/payers/index.js'
import { PrismaPayerRepository } from './prisma-payer.repository.js'

/** Liga `PAYER_REPOSITORY` a Prisma. `PrismaService` llega del `PrismaModule` global. */
@Module({
  providers: [{ provide: PAYER_REPOSITORY, useClass: PrismaPayerRepository }],
  exports: [PAYER_REPOSITORY],
})
export class PayersPersistenceModule {}
