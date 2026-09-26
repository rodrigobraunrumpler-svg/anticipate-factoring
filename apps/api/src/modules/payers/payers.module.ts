import {
  Inject,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common'
import { APP_CONFIG, type AppConfig } from '#/common/config/index.js'
import { PayersPersistenceModule } from '#/infrastructure/prisma/repositories/payers/payers-persistence.module.js'
import {
  PAYER_REPOSITORY,
  type PayerRepositoryPort,
} from '#/modules/payers/application/ports/payer-repository.port.js'
import { IntakeCapacityMonitor } from '#/modules/payers/application/services/intake-capacity-monitor.js'
import { ListPublicPayersUseCase } from '#/modules/payers/application/use-cases/list-public-payers.use-case.js'
import { PayersController } from '#/modules/payers/presentation/http/controllers/payers.controller.js'

/**
 * Pagadores: `GET /api/v1/payers`. El caso de uso y el monitor de los topes de subida son clases sin
 * Nest y se cablean aquí. Al arrancar, el módulo revisa los topes contra los pagadores activos sin
 * frenar el arranque; al cerrarse, espera esa revisión para que no quede una consulta en vuelo cuando
 * `PrismaService` cierra el pool (en `onApplicationShutdown`, después de `onModuleDestroy`).
 */
@Module({
  imports: [PayersPersistenceModule],
  controllers: [PayersController],
  providers: [
    {
      provide: IntakeCapacityMonitor,
      inject: [APP_CONFIG, PAYER_REPOSITORY],
      useFactory: ({ upload }: AppConfig, payers: PayerRepositoryPort) =>
        new IntakeCapacityMonitor(upload, payers, new Logger(IntakeCapacityMonitor.name)),
    },
    {
      provide: ListPublicPayersUseCase,
      inject: [PAYER_REPOSITORY, IntakeCapacityMonitor],
      useFactory: (payers: PayerRepositoryPort, capacity: IntakeCapacityMonitor) =>
        new ListPublicPayersUseCase(payers, capacity),
    },
  ],
})
export class PayersModule implements OnApplicationBootstrap, OnModuleDestroy {
  private startupReview: Promise<void> = Promise.resolve()

  constructor(@Inject(IntakeCapacityMonitor) private readonly capacity: IntakeCapacityMonitor) {}

  onApplicationBootstrap(): void {
    // `reviewActivePayers` nunca rechaza: con la base caída lo avisa y sigue.
    this.startupReview = this.capacity.reviewActivePayers()
  }

  async onModuleDestroy(): Promise<void> {
    await this.startupReview
  }
}
