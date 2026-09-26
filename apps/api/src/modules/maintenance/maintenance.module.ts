import { type DynamicModule, Module, type ModuleMetadata } from '@nestjs/common'
import { APP_CONFIG, type AppConfig } from '#/common/config/index.js'
import { FILE_STORAGE, type FileStoragePort } from '#/common/storage/index.js'
import {
  STORED_FILE_MAINTENANCE,
  type StoredFileMaintenancePort,
} from './application/ports/stored-file-maintenance.port.js'
import { PurgeDeletedFilesUseCase } from './application/use-cases/purge-deleted-files.use-case.js'
import { SweepOrphanFilesUseCase } from './application/use-cases/sweep-orphan-files.use-case.js'

/** Filas por lote del barrido y del borrado diferido. Valor técnico: no varía por entorno. */
export const STORED_FILE_BATCH_SIZE = 200
/** Lotes por pasada: 2000 archivos por pasada; lo que sobre sigue en la próxima. */
export const STORED_FILE_MAX_BATCHES = 10

export type MaintenanceModuleOptions = {
  /** Módulos que proveen `STORED_FILE_MAINTENANCE`. Los elige la raíz de composición. */
  readonly imports: NonNullable<ModuleMetadata['imports']>
}

/**
 * Cablea los casos de uso del ciclo de vida de los archivos. La persistencia llega por `register` y
 * no por un import fijo: el adaptador de Prisma importa `modules/maintenance/index.ts` para
 * implementar el puerto, y si este módulo importara al adaptador se cerraría un ciclo de imports.
 */
@Module({})
export class MaintenanceModule {
  static register(options: MaintenanceModuleOptions): DynamicModule {
    return {
      module: MaintenanceModule,
      imports: [...options.imports],
      providers: [
        {
          provide: SweepOrphanFilesUseCase,
          inject: [STORED_FILE_MAINTENANCE, APP_CONFIG],
          useFactory: (files: StoredFileMaintenancePort, config: AppConfig) =>
            new SweepOrphanFilesUseCase(files, {
              graceMinutes: config.storage.orphanGraceMinutes,
              batchSize: STORED_FILE_BATCH_SIZE,
              maxBatches: STORED_FILE_MAX_BATCHES,
            }),
        },
        {
          provide: PurgeDeletedFilesUseCase,
          inject: [STORED_FILE_MAINTENANCE, FILE_STORAGE],
          useFactory: (files: StoredFileMaintenancePort, storage: FileStoragePort) =>
            new PurgeDeletedFilesUseCase(files, storage, {
              batchSize: STORED_FILE_BATCH_SIZE,
              maxBatches: STORED_FILE_MAX_BATCHES,
            }),
        },
      ],
      exports: [SweepOrphanFilesUseCase, PurgeDeletedFilesUseCase],
    }
  }
}
