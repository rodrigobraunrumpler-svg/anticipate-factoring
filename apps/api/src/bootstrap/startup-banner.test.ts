import { describe, expect, it } from 'vitest'
import { startupBannerLines } from './startup-banner.js'

describe('startupBannerLines', () => {
  it('en desarrollo muestra el entorno y las URL completas de la API, Swagger y la salud', () => {
    expect(startupBannerLines({ nodeEnv: 'development', port: 4001 })).toEqual([
      'Entorno: development',
      'API: http://localhost:4001/api/v1',
      'Swagger: http://localhost:4001/docs',
      'Salud: http://localhost:4001/health',
    ])
  })

  it('en test también muestra las URL, porque Swagger se monta fuera de producción', () => {
    expect(startupBannerLines({ nodeEnv: 'test', port: 4000 })).toContain(
      'Swagger: http://localhost:4000/docs',
    )
  })

  it('en producción no muestra URL ni Swagger: solo el puerto y el entorno', () => {
    expect(startupBannerLines({ nodeEnv: 'production', port: 4000 })).toEqual([
      'API escuchando en el puerto 4000 (production)',
    ])
  })
})
