import type { Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { createClientIpProbe } from './client-ip-probe.middleware.js'

function requestFrom(headers: Record<string, string>, ip: string, url = '/api/v1/payers'): Request {
  return {
    url,
    ip,
    socket: { remoteAddress: ip },
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request
}

const PROXY = '172.17.0.1'

describe('createClientIpProbe', () => {
  it('registra un error una sola vez por tipo de problema, sin IP ni cabeceras, y siempre sigue', () => {
    const logger = { error: vi.fn() }
    const probe = createClientIpProbe({
      trustProxy: 'loopback',
      trustCloudflareHeaders: false,
      logger,
    })
    const next = vi.fn<() => void>()
    const untrusted = requestFrom({ 'x-forwarded-for': '190.40.0.1' }, PROXY)
    const ignored = requestFrom({ 'cf-connecting-ip': '190.40.0.2' }, PROXY)
    for (let n = 0; n < 3; n += 1) {
      probe(untrusted, {} as Response, next)
      probe(ignored, {} as Response, next)
    }
    expect(next).toHaveBeenCalledTimes(6)
    expect(logger.error).toHaveBeenCalledTimes(2)
    expect(logger.error.mock.calls.map(([context]) => context)).toEqual([
      {
        misconfiguration: 'forwarded-for-untrusted',
        trustProxy: 'loopback',
        trustCloudflareHeaders: false,
      },
      {
        misconfiguration: 'cloudflare-header-ignored',
        trustProxy: 'loopback',
        trustCloudflareHeaders: false,
      },
    ])
    const logged = JSON.stringify(logger.error.mock.calls)
    expect(logged).not.toContain('190.40.0')
    expect(logged).not.toContain(PROXY)
    expect(logged).toContain('TRUST_PROXY')
    expect(logged).toContain('TRUST_CLOUDFLARE_HEADERS=true')
  })

  it('no registra nada con la configuración correcta ni en las sondas de salud', () => {
    const logger = { error: vi.fn() }
    const next = vi.fn<() => void>()
    const behindCloudflare = createClientIpProbe({
      trustProxy: PROXY,
      trustCloudflareHeaders: true,
      logger,
      skip: (req) => req.url === '/health/readiness',
    })
    behindCloudflare(
      requestFrom({ 'cf-connecting-ip': '190.40.0.1', 'x-forwarded-for': '190.40.0.1' }, PROXY),
      {} as Response,
      next,
    )
    // El monitoreo puede llegar por el proxy sin pasar por Cloudflare.
    behindCloudflare(
      requestFrom({ 'x-forwarded-for': '198.51.100.1' }, PROXY, '/health/readiness'),
      {} as Response,
      next,
    )
    expect(next).toHaveBeenCalledTimes(2)
    expect(logger.error).not.toHaveBeenCalled()
    behindCloudflare(requestFrom({ 'x-forwarded-for': '190.40.0.1' }, PROXY), {} as Response, next)
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error.mock.calls[0]?.[0]).toMatchObject({
      misconfiguration: 'cloudflare-header-missing',
    })
  })
})
