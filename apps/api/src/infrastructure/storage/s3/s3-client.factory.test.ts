import { createServer, type Server, type Socket } from 'node:net'
import { ListObjectsV2Command } from '@aws-sdk/client-s3'
import { afterEach, describe, expect, it } from 'vitest'
import { createS3Client, S3_CLIENT_TUNING } from './s3-client.factory.js'

const settings = {
  endpoint: 'http://127.0.0.1:9090',
  region: 'us-east-1',
  forcePathStyle: true,
  accessKeyId: 'local',
  secretAccessKey: 'local',
}

/** Servidor TCP que acepta conexiones y nunca responde: un proveedor colgado. */
async function startSilentServer(): Promise<{ url: string; stop: () => Promise<void> }> {
  const sockets = new Set<Socket>()
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('sin puerto')
  return {
    url: `http://127.0.0.1:${address.port}`,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe('createS3Client', () => {
  it('apunta al endpoint con rutas bucket/clave y sin sumas de verificación opcionales', async () => {
    const client = createS3Client(settings)
    cleanups.push(() => client.destroy())

    const endpoint = await client.config.endpoint?.()
    expect(endpoint?.hostname).toBe('127.0.0.1')
    expect(endpoint?.port).toBe(9090)
    expect(client.config.forcePathStyle).toBe(true)
    expect(await client.config.region()).toBe('us-east-1')
    expect(await client.config.requestChecksumCalculation()).toBe('WHEN_REQUIRED')
    expect(await client.config.responseChecksumValidation()).toBe('WHEN_REQUIRED')
    expect(await client.config.maxAttempts()).toBe(S3_CLIENT_TUNING.maxAttempts)
  })

  it('sin endpoint deja que el SDK resuelva el del proveedor', () => {
    const client = createS3Client({ ...settings, endpoint: undefined, region: 'auto' })
    cleanups.push(() => client.destroy())
    expect(client.config.endpoint).toBeUndefined()
  })

  it('corta con TimeoutError una petición que el proveedor deja colgada', async () => {
    const silent = await startSilentServer()
    cleanups.push(silent.stop)
    const client = createS3Client(
      { ...settings, endpoint: silent.url },
      { connectionTimeoutMs: 200, requestTimeoutMs: 300, maxAttempts: 1 },
    )
    cleanups.push(() => client.destroy())

    const startedAt = Date.now()
    await expect(
      client.send(new ListObjectsV2Command({ Bucket: 'anticipate-local', MaxKeys: 1 })),
    ).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(Date.now() - startedAt).toBeLessThan(3_000)
  })
})
