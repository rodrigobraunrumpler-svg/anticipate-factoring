import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common'
import { PrismaPg } from '@prisma/adapter-pg'
import pg from 'pg'
import { APP_CONFIG, type AppConfig } from '#/common/config/index.js'
import { type Prisma, PrismaClient } from './generated/client.js'

/** Nombre con el que la API aparece en `pg_stat_activity`. */
export const DATABASE_APPLICATION_NAME = 'anticipate-api'

/**
 * Columnas que ninguna consulta devuelve salvo que las pida con `omit: { campo: false }`. El hash de
 * la contraseña solo lo necesita el login (paso 4). `invoices.creating_xact_start` es de la base
 * (D49): el cliente lo truncaría a milisegundos y escribirlo de vuelta lo rechaza `invoices_guard`.
 */
export const PRISMA_CLIENT_OMIT = {
  user: { passwordHash: true },
  invoice: { creatingXactStart: true },
} as const

/**
 * Cliente que recibe el callback de un `$transaction` interactivo: lo usan los repositorios que
 * escriben varias tablas en una transacción (por ejemplo, `insertOutboxMessages` del outbox).
 */
export type PrismaTransaction = Prisma.TransactionClient

/** Límites de toda transacción interactiva: tiempo total y espera por una conexión del pool. */
export type TransactionOptions = { readonly timeout: number; readonly maxWait: number }

type PrismaServiceOptions = {
  adapter: PrismaPg
  omit: typeof PRISMA_CLIENT_OMIT
  transactionOptions: TransactionOptions
}

/**
 * Pool de `pg` de la API. Recibe solo estas opciones: `statement_timeout`, `lock_timeout` e
 * `idle_in_transaction_session_timeout` los fija la base (migración `integrity`), porque el pooler de
 * Neon (PgBouncer en modo transacción) rechaza la conexión si llegan como parámetros de arranque.
 */
export function createDatabasePool(database: AppConfig['database']): pg.Pool {
  return new pg.Pool({
    connectionString: database.url,
    max: database.poolMax,
    connectionTimeoutMillis: database.connectionTimeoutMs,
    idleTimeoutMillis: database.idleTimeoutMs,
    application_name: DATABASE_APPLICATION_NAME,
  })
}

/**
 * Cliente de Prisma de la API sobre un pool propio de `pg`. No se conecta al construirse: la primera
 * consulta abre la conexión. Así la API arranca aunque la base esté caída un momento; lo informa
 * `GET /health/readiness` y el orquestador no le manda tráfico hasta que la base responda.
 *
 * Se cierra en `onApplicationShutdown`, el último hook de Nest: los schedulers se detienen y esperan
 * su pasada en curso en `onModuleDestroy`, antes, así que nunca encuentran el pool cerrado.
 */
@Injectable()
export class PrismaService
  extends PrismaClient<PrismaServiceOptions>
  implements OnApplicationShutdown
{
  /** El pool de `pg` que usa el adaptador. Solo para el cierre y los tests. */
  readonly databasePool: pg.Pool
  /** El adaptador de Prisma sobre `databasePool`. Solo para los tests. */
  readonly driverAdapter: PrismaPg
  /** Los mismos límites que el cliente aplica por defecto a cada `$transaction`. */
  readonly transactionOptions: TransactionOptions
  private readonly logger = new Logger(PrismaService.name)

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const pool = createDatabasePool(config.database)
    const adapter = new PrismaPg(pool)
    const transactionOptions: TransactionOptions = {
      timeout: config.database.transactionTimeoutMs,
      maxWait: config.database.transactionMaxWaitMs,
    }
    super({ adapter, omit: PRISMA_CLIENT_OMIT, transactionOptions })
    this.databasePool = pool
    this.driverAdapter = adapter
    this.transactionOptions = transactionOptions
    // Sin un oyente de 'error', una conexión inactiva que se corta (reinicio de la base, red) tumba
    // el proceso. El adaptador pone el suyo solo mientras el cliente está conectado; este queda
    // siempre. El mensaje de pg no trae datos de las filas.
    pool.on('error', (error: Error & { code?: string }) => {
      this.logger.error(
        `Se cortó una conexión inactiva con PostgreSQL (${error.code ?? 'sin código'}): ${error.message}`,
      )
    })
  }

  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect()
    if (!this.databasePool.ended) await this.databasePool.end()
  }
}
