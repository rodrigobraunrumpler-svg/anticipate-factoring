import { Controller, Get, Inject, VERSION_NEUTRAL } from '@nestjs/common'
import { HealthCheck, type HealthCheckResult, HealthCheckService } from '@nestjs/terminus'
import { SkipThrottle } from '@nestjs/throttler'
import { HEALTH_PATHS } from '#/bootstrap/constants.js'
import { SkipResponseEnvelope } from '#/common/decorators/skip-response-envelope.decorator.js'
import { PrismaReadinessIndicator } from '#/infrastructure/prisma/index.js'
import { OutboxBacklogReadinessIndicator } from '#/infrastructure/prisma/repositories/maintenance/outbox-backlog-readiness.indicator.js'
import { S3ReadinessIndicator } from '#/infrastructure/storage/s3/index.js'

/**
 * Sondas del orquestador y del monitoreo externo: fuera del prefijo `api`, sin versión
 * (`VERSION_NEUTRAL`), sin límite de peticiones y con el cuerpo de Terminus, sin sobre. Terminus
 * agrega `Cache-Control: no-cache`.
 */
@SkipThrottle()
@SkipResponseEnvelope()
@Controller({ version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly database: PrismaReadinessIndicator,
    @Inject(S3ReadinessIndicator) private readonly storageReadiness: S3ReadinessIndicator,
    @Inject(OutboxBacklogReadinessIndicator)
    private readonly outboxBacklog: OutboxBacklogReadinessIndicator,
  ) {}

  /**
   * Liveness: solo dice que el proceso responde. Nunca toca la base ni el almacenamiento, para que un
   * corte breve de Neon o de R2 no haga que el orquestador reinicie todos los contenedores a la vez.
   */
  @Get(HEALTH_PATHS.liveness)
  @HealthCheck()
  liveness(): Promise<HealthCheckResult> {
    return this.health.check([() => ({ process: { status: 'up' } })])
  }

  /**
   * Readiness: la base, el almacenamiento y el backlog del outbox. Un backlog con eventos fallidos o
   * atrasados sale `degraded` con 200 (ver `OutboxBacklogReadinessIndicator`); la base o el
   * almacenamiento caídos, o el outbox sin responder, salen 503.
   */
  @Get(HEALTH_PATHS.readiness)
  @HealthCheck()
  readiness(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.database.isHealthy(),
      () => this.storageReadiness.check('storage'),
      () => this.outboxBacklog.check('outbox'),
    ])
  }
}
