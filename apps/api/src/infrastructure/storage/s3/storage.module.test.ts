import type { S3Client } from '@aws-sdk/client-s3'
import { Test } from '@nestjs/testing'
import { describe, expect, it, vi } from 'vitest'
import { AppConfigModule } from '#/common/config/index.js'
import { FILE_STORAGE, type FileStoragePort } from '#/common/storage/index.js'
import { testConfig } from '../../../../test/support/config.js'
import { S3_CLIENT, S3_CLIENT_TUNING } from './s3-client.factory.js'
import { S3_REQUEST_LIMITS, S3FileStorageAdapter } from './s3-file-storage.adapter.js'
import { S3ReadinessIndicator } from './s3-readiness.indicator.js'
import { StorageModule } from './storage.module.js'

describe('StorageModule', () => {
  it('provee el puerto y el indicador con el bucket de la configuración y cierra el cliente al final', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule.register(testConfig({ S3_BUCKET: 'bucket-de-prueba' })),
        StorageModule,
      ],
    }).compile()
    await moduleRef.init()

    const storage = moduleRef.get<FileStoragePort>(FILE_STORAGE)
    expect(storage).toBeInstanceOf(S3FileStorageAdapter)
    expect(storage.bucket).toBe('bucket-de-prueba')
    expect(moduleRef.get(S3ReadinessIndicator)).toBeInstanceOf(S3ReadinessIndicator)

    const destroy = vi.spyOn(moduleRef.get<S3Client>(S3_CLIENT), 'destroy')
    await moduleRef.close()
    expect(destroy).toHaveBeenCalledOnce()
  })

  it('el adaptador deja sockets libres a la readiness y su plazo cubre todos los intentos del cliente', () => {
    // Adaptador e indicador comparten el cliente: si el adaptador pudiera ocupar todos los sockets,
    // la readiness esperaría en cola y vencería con el proveedor sano.
    expect(S3_REQUEST_LIMITS.maxConcurrentRequests).toBeLessThan(S3_CLIENT_TUNING.maxSockets)
    expect(S3_REQUEST_LIMITS.maxConcurrentRequestsPerCall).toBeLessThan(
      S3_REQUEST_LIMITS.maxConcurrentRequests,
    )
    expect(S3_REQUEST_LIMITS.operationTimeoutMs).toBeGreaterThan(
      S3_CLIENT_TUNING.maxAttempts * S3_CLIENT_TUNING.requestTimeoutMs,
    )
  })
})
