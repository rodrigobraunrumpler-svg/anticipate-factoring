import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { describe, expect, it } from 'vitest'
import { TEST_ENV_DEFAULTS, testConfig, testEnv } from '../../../test/support/config.js'
import { parseConfig } from './app-config.js'
import { ENVIRONMENT_KEYS, SEED_ENVIRONMENT_KEYS } from './environment.schema.js'

/** Variables de un archivo `.env` de `apps/api`, leídas con el mismo parser que usa Node. */
function readEnvFile(name: string): Record<string, string> {
  const content = readFileSync(new URL(`../../../${name}`, import.meta.url), 'utf8')
  return parseEnv(content) as Record<string, string>
}

const sorted = (keys: Iterable<string>) => [...keys].sort()

/** Las usan solo los helpers de los tests de integración; no son configuración de la API. */
const TEST_ONLY_KEYS = ['MAILPIT_API_URL']

describe('.env.example', () => {
  it('declara exactamente las variables del esquema y las del seed', () => {
    expect(sorted(Object.keys(readEnvFile('.env.example')))).toEqual(
      sorted([...ENVIRONMENT_KEYS, ...SEED_ENVIRONMENT_KEYS]),
    )
  })

  it('las variables del seed no pisan ninguna de la API', () => {
    const shared = SEED_ENVIRONMENT_KEYS.filter((key) =>
      (ENVIRONMENT_KEYS as readonly string[]).includes(key),
    )
    expect(shared).toEqual([])
  })

  it('es una configuración de desarrollo válida', () => {
    const config = parseConfig(readEnvFile('.env.example'))
    expect(config.nodeEnv).toBe('development')
    expect(config.mail.transport).toBe('smtp')
  })
})

describe('.env.test.example', () => {
  it('solo declara variables del esquema o de los helpers de integración', () => {
    const allowed = new Set<string>([...ENVIRONMENT_KEYS, ...TEST_ONLY_KEYS])
    expect(
      Object.keys(readEnvFile('.env.test.example')).filter((key) => !allowed.has(key)),
    ).toEqual([])
  })

  it('apunta a anticipate_test y a la base shadow, nunca a la de desarrollo', () => {
    const env = readEnvFile('.env.test.example')
    expect(new URL(env.DATABASE_URL ?? '').pathname).toBe('/anticipate_test')
    expect(new URL(env.DATABASE_DIRECT_URL ?? '').pathname).toBe('/anticipate_test')
    expect(new URL(env.SHADOW_DATABASE_URL ?? '').pathname).toBe('/anticipate_shadow')
  })
})

describe('testEnv', () => {
  it('declara todas las variables del esquema', () => {
    expect(sorted(Object.keys(TEST_ENV_DEFAULTS))).toEqual(sorted(ENVIRONMENT_KEYS))
    expect(sorted(Object.keys(testEnv()))).toEqual(sorted(ENVIRONMENT_KEYS))
  })

  it('es válida y nunca arranca el publicador, el mantenimiento ni el correo real', () => {
    const config = testConfig()
    expect(config.nodeEnv).toBe('test')
    expect(config.outbox.pollerEnabled).toBe(false)
    expect(config.maintenance.enabled).toBe(false)
    expect(config.mail.transport).toBe('fake')
  })

  it('se niega a usar una base que no termine en _test', () => {
    expect(() =>
      testEnv({ DATABASE_URL: 'postgresql://anticipate:anticipate@127.0.0.1:5432/anticipate' }),
    ).toThrow(
      'DATABASE_URL apunta a la base «anticipate»: los tests solo corren contra una base que termine en _test.',
    )
  })
})
