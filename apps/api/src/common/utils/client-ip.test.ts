import type { Request } from 'express'
import { describe, expect, it } from 'vitest'
import { diagnoseClientIp, resolveClientIp, UNKNOWN_CLIENT_IP } from './client-ip.js'

function requestFrom(options: {
  ip?: string
  remoteAddress?: string
  cloudflareIp?: string | undefined
  forwardedFor?: string
}): Request {
  const headers: Record<string, string | undefined> = {
    'cf-connecting-ip': options.cloudflareIp,
    'x-forwarded-for': options.forwardedFor,
  }
  return {
    ip: options.ip,
    socket: { remoteAddress: options.remoteAddress },
    get: (name: string) => headers[name.toLowerCase()],
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

  it('una req.ip que no es una IP válida para inet se reemplaza por UNKNOWN_CLIENT_IP', () => {
    // Detrás de un proxy de confianza, Express toma de X-Forwarded-For lo que venga, sin validarlo.
    for (const ip of ['no-es-una-ip', '1.2.3', '', 'fe80::1%eth0']) {
      expect(resolveClientIp(requestFrom({ ip, remoteAddress: '127.0.0.1' }), false)).toBe(
        UNKNOWN_CLIENT_IP,
      )
    }
    expect(resolveClientIp(requestFrom({ remoteAddress: 'fe80::1%eth0' }), false)).toBe(
      UNKNOWN_CLIENT_IP,
    )
    expect(resolveClientIp(requestFrom({ ip: '::ffff:127.0.0.1' }), false)).toBe('::ffff:127.0.0.1')
  })
})

describe('diagnoseClientIp', () => {
  const PROXY = '172.17.0.1'
  const EDGE = '172.70.1.1'
  const VISITOR = '190.40.0.1'

  it('confiando en Cloudflare, una petición con CF-Connecting-IP válida está bien', () => {
    expect(
      diagnoseClientIp(
        requestFrom({
          ip: PROXY,
          remoteAddress: PROXY,
          cloudflareIp: VISITOR,
          forwardedFor: `${VISITOR}, ${EDGE}`,
        }),
        true,
      ),
    ).toBeNull()
  })

  it('confiando en Cloudflare, una petición que llega por un proxy sin CF-Connecting-IP válida es un aviso', () => {
    for (const cloudflareIp of [undefined, 'no-es-una-ip']) {
      expect(
        diagnoseClientIp(
          requestFrom({ ip: PROXY, remoteAddress: PROXY, cloudflareIp, forwardedFor: VISITOR }),
          true,
        ),
      ).toBe('cloudflare-header-missing')
    }
    // Sin proxy ni Cloudflare (la sonda de Docker desde 127.0.0.1): nada que avisar.
    expect(
      diagnoseClientIp(requestFrom({ ip: '127.0.0.1', remoteAddress: '127.0.0.1' }), true),
    ).toBeNull()
  })

  it('sin confiar en Cloudflare, si Cloudflare informa otra IP que la que se usa, es un aviso', () => {
    // El borde de Cloudflare o el proxy como IP de todos los visitantes.
    expect(
      diagnoseClientIp(
        requestFrom({
          ip: EDGE,
          remoteAddress: PROXY,
          cloudflareIp: VISITOR,
          forwardedFor: `${VISITOR}, ${EDGE}`,
        }),
        false,
      ),
    ).toBe('cloudflare-header-ignored')
    expect(
      diagnoseClientIp(
        requestFrom({ ip: PROXY, remoteAddress: PROXY, cloudflareIp: VISITOR }),
        false,
      ),
    ).toBe('cloudflare-header-ignored')
    // TRUST_PROXY que incluye los rangos de Cloudflare: la IP usada es la del visitante.
    expect(
      diagnoseClientIp(
        requestFrom({
          ip: VISITOR,
          remoteAddress: PROXY,
          cloudflareIp: VISITOR,
          forwardedFor: `${VISITOR}, ${EDGE}`,
        }),
        false,
      ),
    ).toBeNull()
  })

  it('sin confiar en Cloudflare, un X-Forwarded-For que trust proxy no usó es un aviso', () => {
    // req.ip es la del socket: Express ignoró la cabecera porque el proxy no es de confianza.
    expect(
      diagnoseClientIp(
        requestFrom({ ip: PROXY, remoteAddress: PROXY, forwardedFor: VISITOR }),
        false,
      ),
    ).toBe('forwarded-for-untrusted')
    // Proxy de confianza: req.ip sale de la cabecera.
    expect(
      diagnoseClientIp(
        requestFrom({ ip: VISITOR, remoteAddress: PROXY, forwardedFor: VISITOR }),
        false,
      ),
    ).toBeNull()
    // Conexión directa, sin proxy.
    expect(diagnoseClientIp(requestFrom({ ip: VISITOR, remoteAddress: VISITOR }), false)).toBeNull()
  })
})
