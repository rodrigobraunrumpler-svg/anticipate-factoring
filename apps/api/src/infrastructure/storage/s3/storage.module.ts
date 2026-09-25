import type { S3Client } from '@aws-sdk/client-s3'
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common'
import { HealthIndicatorService, TerminusModule } from '@nestjs/terminus'
import { APP_CONFIG, type AppConfig } from '#/common/config/index.js'
import { FILE_STORAGE } from '#/common/storage/index.js'
import { createS3Client, S3_CLIENT } from './s3-client.factory.js'
import { S3FileStorageAdapter } from './s3-file-storage.adapter.js'
import {
  S3_READINESS_CACHE_TTL_MS,
  S3_READINESS_TIMEOUT_MS,
  S3ReadinessIndicator,
} from './s3-readiness.indicator.js'

/**
 * Dueño del cliente S3. Exporta solo el puerto `FILE_STORAGE` y el indicador de readiness, nunca
 * el cliente: ningún módulo de negocio llega al bucket sin pasar por el puerto.
 */
@Global()
@Module({
  imports: [TerminusModule],
  providers: [
    {
      provide: S3_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createS3Client(config.storage),
    },
    {
      provide: FILE_STORAGE,
      inject: [S3_CLIENT, APP_CONFIG],
      useFactory: (client: S3Client, config: AppConfig) =>
        new S3FileStorageAdapter(client, { bucket: config.storage.bucket }),
    },
    {
      provide: S3ReadinessIndicator,
      inject: [S3_CLIENT, HealthIndicatorService, APP_CONFIG],
      useFactory: (client: S3Client, indicators: HealthIndicatorService, config: AppConfig) =>
        new S3ReadinessIndicator(client, indicators, {
          bucket: config.storage.bucket,
          timeoutMs: S3_READINESS_TIMEOUT_MS,
          cacheTtlMs: S3_READINESS_CACHE_TTL_MS,
        }),
    },
  ],
  exports: [FILE_STORAGE, S3ReadinessIndicator],
})
export class StorageModule implements OnApplicationShutdown {
  constructor(@Inject(S3_CLIENT) private readonly client: S3Client) {}

  /** Último hook de Nest: los workers ya terminaron su pasada cuando se cierra el cliente. */
  onApplicationShutdown(): void {
    this.client.destroy()
  }
}
