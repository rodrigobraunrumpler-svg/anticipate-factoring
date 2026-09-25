import type { Request } from 'express'
import { describe, expect, it } from 'vitest'
import { resolveClientIp, UNKNOWN_CLIENT_IP } from './client-ip.js'

function requestFrom(options: {
  ip?: string
  remoteAddress?: string
  cloudflareIp?: string
}): Request {
  return {
    ip: options.ip,
    socket: { remoteAddress: options.remoteAddress },
    get: (name: string) => (name === 'cf-connecting-ip' ? options.cloudflareIp : undefined),
  } as unknown as Request
}

describe('resolveClientIp', () => {
  it('usa req.ip (derivada de trust proxy) cuando no se confía en Cloudflare', () => {
    expect(
      resolveClientIp(requestFrom({ ip: '198.51.100.7', cloudflareIp: '203.0.113.1' }), false),
    ).toBe('198.51.100.7')
  })

  it('usa CF-Connecting-IP cuando se confía en Cloudflare y trae una IP válida', () => {
    expect(
      resolveClientIp(requestFrom({ ip: '198.51.100.7', cloudflareIp: ' 2001:db8::1 ' }), true),
    ).toBe('2001:db8::1')
  })

  it('ignora un CF-Connecting-IP que no es una IP', () => {
    for (const cloudflareIp of ['1.2.3', 'cliente', '']) {
      expect(resolveClientIp(requestFrom({ ip: '198.51.100.7', cloudflareIp }), true)).toBe(
        '198.51.100.7',
      )
    }
  })

  it('sin req.ip usa la dirección del socket y, si tampoco hay, una IP válida para inet', () => {
    expect(resolveClientIp(requestFrom({ remoteAddress: '::1' }), false)).toBe('::1')
    expect(resolveClientIp(requestFrom({}), false)).toBe(UNKNOWN_CLIENT_IP)
  })
})
