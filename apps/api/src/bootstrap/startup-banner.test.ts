import { describe, expect, it } from 'vitest'
import { startupBannerLines } from './startup-banner.js'

const DEVELOPMENT_CLIENT_IP = { trustProxy: 'loopback', trustCloudflareHeaders: false } as const

describe('startupBannerLines', () => {
  it('en desarrollo muestra el entorno, las URL completas de la API, Swagger y la salud, y de dónde sale la IP del cliente', () => {
    expect(
      startupBannerLines({ nodeEnv: 'development', port: 4001, ...DEVELOPMENT_CLIENT_IP }),
    ).toEqual([
      'Entorno: development',
      'API: http://localhost:4001/api/v1',
      'Swagger: http://localhost:4001/docs',
      'Salud: http://localhost:4001/health',
      'IP del cliente: la de la conexión o la de X-Forwarded-For si el proxy es de confianza (TRUST_PROXY=loopback); CF-Connecting-IP no se usa',
    ])
  })

  it('en test también muestra las URL, porque Swagger se monta fuera de producción', () => {
    expect(startupBannerLines({ nodeEnv: 'test', port: 4000, ...DEVELOPMENT_CLIENT_IP })).toContain(
      'Swagger: http://localhost:4000/docs',
    )
  })

  it('en producción no muestra URL ni Swagger: el puerto, el entorno y de dónde sale la IP del cliente', () => {
    expect(
      startupBannerLines({
        nodeEnv: 'production',
        port: 4000,
        trustProxy: '172.17.0.1',
        trustCloudflareHeaders: true,
      }),
    ).toEqual([
      'API escuchando en el puerto 4000 (production)',
      'IP del cliente: CF-Connecting-IP de Cloudflare; sin ella, la de la conexión o la de X-Forwarded-For si el proxy es de confianza (TRUST_PROXY=172.17.0.1)',
    ])
    expect(
      startupBannerLines({
        nodeEnv: 'production',
        port: 4000,
        trustProxy: false,
        trustCloudflareHeaders: false,
      }).at(-1),
    ).toBe(
      'IP del cliente: la de la conexión o la de X-Forwarded-For si el proxy es de confianza (TRUST_PROXY=false); CF-Connecting-IP no se usa',
    )
  })
})
