import { Injectable, Logger } from '@nestjs/common'
import { type HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus'
import { PrismaService } from './prisma.service.js'

/** Clave del indicador en el cuerpo de Terminus (`info.database`, `error.database`). */
export const DATABASE_HEALTH_KEY = 'database'

/** Tope de la consulta de readiness: la sonda del orquestador espera poco. */
export const DATABASE_READINESS_TIMEOUT_MS = 2_000

/**
 * Readiness de PostgreSQL: un `SELECT 1` por el mismo pool de la API, con tope de tiempo. El cuerpo
 * de la sonda es público: si la base falla, dice solo que no respondió; la causa (host, puerto,
 * código) va al log.
 */
@Injectable()
export class PrismaReadinessIndicator {
  private readonly logger = new Logger(PrismaReadinessIndicator.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly indicators: HealthIndicatorService,
  ) {}

  async isHealthy(): Promise<HealthIndicatorResult<typeof DATABASE_HEALTH_KEY>> {
    return this.indicators
      .check(DATABASE_HEALTH_KEY)
      .attempt(async () => {
        try {
          await this.prisma.$queryRaw`SELECT 1`
        } catch (error) {
          this.logger.warn(
            `PostgreSQL no respondió a la readiness: ${error instanceof Error ? error.message : String(error)}`,
          )
          throw new Error('La base de datos no respondió.')
        }
      })
      .withTimeout(DATABASE_READINESS_TIMEOUT_MS)
  }
}
