import { describe, expect, it } from 'vitest'
import { testConfig, testContainerEnv } from '../support/config.js'
import { readTestEnvFile } from './global-setup.js'

describe('entorno de los tests de integración', () => {
  it('toma las URLs de los contenedores solo de apps/api/.env.test', () => {
    const file = readTestEnvFile()
    expect(testContainerEnv()).toEqual(file)
    expect(testConfig().database.url).toBe(file.DATABASE_URL)
  })

  it('corre contra anticipate_test: la base que se trunca nunca es otra', () => {
    expect(new URL(testConfig().database.url).pathname).toBe('/anticipate_test')
  })
})
