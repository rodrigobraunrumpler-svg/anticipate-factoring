import type { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { HealthIndicatorService } from '@nestjs/terminus'
import { describe, expect, it } from 'vitest'
import {
  S3ReadinessIndicator,
  STORAGE_UNAVAILABLE_MESSAGE,
  storageTimeoutMessage,
} from './s3-readiness.indicator.js'

type Send = (
  command: ListObjectsV2Command,
  options: { abortSignal: AbortSignal },
) => Promise<unknown>

function indicatorWith(send: Send, options: { timeoutMs?: number; cacheTtlMs?: number } = {}) {
  const calls: Array<{ input: unknown }> = []
  const client = {
    send: (command: ListObjectsV2Command, sendOptions: { abortSignal: AbortSignal }) => {
      calls.push({ input: command.input })
      return send(command, sendOptions)
    },
  } as unknown as S3Client
  const indicator = new S3ReadinessIndicator(client, new HealthIndicatorService(), {
    bucket: 'anticipate-local',
    timeoutMs: options.timeoutMs ?? 1_000,
    cacheTtlMs: options.cacheTtlMs ?? 0,
  })
  return { indicator, calls }
}

/** Como el SDK: rechaza con AbortError cuando se cancela la señal y nunca responde antes. */
const hangUntilAborted: Send = (_command, { abortSignal }) =>
  new Promise((_resolve, reject) => {
    abortSignal.addEventListener('abort', () => {
      const error = new Error('Request aborted')
      error.name = 'AbortError'
      reject(error)
    })
  })

describe('S3ReadinessIndicator', () => {
  it('está arriba si puede listar una clave del bucket configurado', async () => {
    const { indicator, calls } = indicatorWith(() => Promise.resolve({ KeyCount: 0 }))

    const result = await indicator.check('storage')

    expect(result.storage?.status).toBe('up')
    expect(calls).toEqual([{ input: { Bucket: 'anticipate-local', MaxKeys: 1 } }])
  })

  it('está abajo con un mensaje fijo que no revela el error del proveedor', async () => {
    const { indicator } = indicatorWith(() =>
      Promise.reject(new Error('getaddrinfo ENOTFOUND cuenta-secreta.r2.cloudflarestorage.com')),
    )

    const result = await indicator.check('storage')

    expect(result.storage).toMatchObject({ status: 'down', message: STORAGE_UNAVAILABLE_MESSAGE })
    expect(JSON.stringify(result)).not.toContain('cuenta-secreta')
  })

  it('está abajo por tiempo si el proveedor no responde', async () => {
    const { indicator } = indicatorWith(hangUntilAborted, { timeoutMs: 50 })

    const startedAt = Date.now()
    const result = await indicator.check('storage')

    expect(result.storage).toMatchObject({ status: 'down', message: storageTimeoutMessage(50) })
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })

  it('está abajo a tiempo y con el mensaje fijo aunque el cliente no atienda la cancelación', async () => {
    // Como el SDK entre dos intentos: la señal no interrumpe la espera y la consulta no termina.
    const { indicator } = indicatorWith(() => new Promise(() => {}), { timeoutMs: 50 })

    const startedAt = Date.now()
    const result = await indicator.check('storage')

    expect(result.storage).toMatchObject({ status: 'down', message: storageTimeoutMessage(50) })
    // Dentro del plazo más un margen de 500 ms, y nunca con el texto en inglés de Terminus.
    expect(Date.now() - startedAt).toBeLessThan(50 + 500)
    expect(JSON.stringify(result)).not.toMatch(/timeout of|exceeded/)
  })

  it('reutiliza el resultado mientras dura la caché: una ráfaga de sondeos hace una consulta', async () => {
    const { indicator, calls } = indicatorWith(() => Promise.resolve({ KeyCount: 0 }), {
      cacheTtlMs: 60_000,
    })

    await Promise.all([indicator.check('storage'), indicator.check('storage')])
    const cached = await indicator.check('storage')

    expect(calls).toHaveLength(1)
    expect(cached.storage).toMatchObject({ status: 'up', cachedResponse: true })
  })
})
