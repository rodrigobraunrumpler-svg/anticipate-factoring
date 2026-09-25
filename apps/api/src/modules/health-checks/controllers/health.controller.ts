import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common'
import { HealthCheck, type HealthCheckResult, HealthCheckService } from '@nestjs/terminus'
import { SkipThrottle } from '@nestjs/throttler'
import { HEALTH_PATHS } from '#/bootstrap/constants.js'
import { SkipResponseEnvelope } from '#/common/decorators/skip-response-envelope.decorator.js'
import { PrismaReadinessIndicator } from '#/infrastructure/prisma/index.js'

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
   * Readiness: la API puede atender. 200 si cada dependencia responde; si no, 503 con el cuerpo de
   * Terminus y el orquestador deja de mandarle tráfico sin reiniciarla. El almacenamiento y el
   * backlog del outbox se agregan en sus tareas.
   */
  @Get(HEALTH_PATHS.readiness)
  @HealthCheck()
  readiness(): Promise<HealthCheckResult> {
    return this.health.check([() => this.database.isHealthy()])
  }
}
