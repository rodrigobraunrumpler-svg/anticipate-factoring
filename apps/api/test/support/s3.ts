import { ListObjectsV2Command } from '@aws-sdk/client-s3'
import { createS3Client } from '#/infrastructure/storage/s3/s3-client.factory.js'
import { S3FileStorageAdapter } from '#/infrastructure/storage/s3/s3-file-storage.adapter.js'
import { testConfig } from './config.js'

/** Falla inyectada: el comando rechaza las claves que terminan en `keySuffix`, sin llegar a S3Mock. */
export type StorageFault = {
  command: 'PutObjectCommand' | 'DeleteObjectCommand' | 'HeadObjectCommand'
  keySuffix: string
}

export type TestStorage = {
  readonly storage: S3FileStorageAdapter
  /** Cierra el cliente S3 del adaptador. */
  readonly destroy: () => void
}

/** Adaptador real contra S3Mock con la configuración de prueba, con otro bucket o con una falla. */
export function createTestStorage(
  options: { bucket?: string; fault?: StorageFault } = {},
): TestStorage {
  const { storage: settings } = testConfig()
  const client = createS3Client(settings)
  const { fault } = options
  if (fault !== undefined) {
    client.middlewareStack.add(
      (next, context) => async (args) => {
        const input = args.input as { Key?: string }
        if (context.commandName === fault.command && input.Key?.endsWith(fault.keySuffix)) {
          throw new Error(`${fault.command} rechazado a propósito`)
        }
        return next(args)
      },
      { step: 'initialize', name: 'testStorageFault' },
    )
  }
  return {
    storage: new S3FileStorageAdapter(client, { bucket: options.bucket ?? settings.bucket }),
    destroy: () => client.destroy(),
  }
}

/** Claves guardadas bajo `prefix` en el bucket de pruebas, en orden alfabético. */
export async function listKeys(prefix: string): Promise<string[]> {
  const { storage: settings } = testConfig()
  const client = createS3Client(settings)
  try {
    const keys: string[] = []
    let continuationToken: string | undefined
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: settings.bucket,
          Prefix: prefix,
          ...(continuationToken === undefined ? {} : { ContinuationToken: continuationToken }),
        }),
      )
      for (const object of page.Contents ?? []) {
        if (object.Key !== undefined) keys.push(object.Key)
      }
      continuationToken = page.IsTruncated === true ? page.NextContinuationToken : undefined
    } while (continuationToken !== undefined)
    return keys.sort()
  } finally {
    client.destroy()
  }
}

/** Borra todo lo que haya bajo `prefix` en el bucket de pruebas; lanza si algo queda. */
export async function deletePrefix(prefix: string): Promise<void> {
  const { storage, destroy } = createTestStorage()
  try {
    const notDeleted = await storage.deleteQuietly(await listKeys(prefix))
    if (notDeleted.length > 0) throw new Error(`No se pudieron borrar: ${notDeleted.join(', ')}`)
  } finally {
    destroy()
  }
}
