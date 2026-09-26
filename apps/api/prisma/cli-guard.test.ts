import { describe, expect, it } from 'vitest'
import { OFFLINE_URL, parsePrismaCommand, resolveCliDatasource } from './cli-guard.js'

const LOCAL = 'postgresql://anticipate:anticipate@127.0.0.1:5433/anticipate'
const LOCAL_SHADOW = 'postgresql://anticipate:anticipate@127.0.0.1:5433/anticipate_shadow'
const NEON_DIRECT = 'postgresql://owner:secreto@ep-quiet-sea-123456.sa-east-1.aws.neon.tech/neondb'
const NEON_POOLER =
  'postgresql://owner:secreto@ep-quiet-sea-123456-pooler.sa-east-1.aws.neon.tech/neondb'

/** argv de Node al correr la CLI: [node, prisma, ...argumentos]. */
const argv = (...args: string[]) => [
  '/usr/bin/node',
  '/repo/node_modules/prisma/build/index.js',
  ...args,
]

const errorOf = (run: () => unknown): string => {
  try {
    run()
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('se esperaba un error')
}

describe('parsePrismaCommand', () => {
  it.each([
    [['migrate', 'deploy'], 'migrate deploy'],
    [['migrate', 'dev', '--name', 'dev'], 'migrate dev'],
    [['--config', 'prisma.config.ts', 'migrate', 'reset', '--force'], 'migrate reset'],
    [['--config=prisma.config.ts', 'db', 'push'], 'db push'],
    [['--schema', 'prisma/schema.prisma', 'migrate', 'status'], 'migrate status'],
    [['migrate', '--create-only', 'dev'], 'migrate dev'],
    [['generate', '--no-hints'], 'generate'],
    [['studio', '--port', '5555'], 'studio'],
    [['--version'], ''],
    [[], ''],
  ])('%j es «%s», sin depender de la posición', (args, expected) => {
    expect(parsePrismaCommand(argv(...args))).toBe(expected)
  })
})

describe('resolveCliDatasource', () => {
  it('usa la URL directa y la sombra local', () => {
    expect(
      resolveCliDatasource(
        { DATABASE_DIRECT_URL: LOCAL, SHADOW_DATABASE_URL: LOCAL_SHADOW },
        argv('migrate', 'dev'),
      ),
    ).toEqual({ url: LOCAL, shadowDatabaseUrl: LOCAL_SHADOW })
  })

  it('fuera de producción, sin la directa, usa DATABASE_URL', () => {
    expect(
      resolveCliDatasource(
        { NODE_ENV: 'development', DATABASE_URL: LOCAL },
        argv('migrate', 'deploy'),
      ),
    ).toEqual({ url: LOCAL })
  })

  it('en producción exige DATABASE_DIRECT_URL', () => {
    expect(
      errorOf(() =>
        resolveCliDatasource(
          { NODE_ENV: 'production', DATABASE_URL: NEON_DIRECT },
          argv('migrate', 'deploy'),
        ),
      ),
    ).toContain('DATABASE_DIRECT_URL')
  })

  it('sin ninguna URL, un comando que se conecta falla con un mensaje claro', () => {
    expect(errorOf(() => resolveCliDatasource({}, argv('migrate', 'deploy')))).toContain(
      'Falta DATABASE_URL',
    )
  })

  it.each([[['generate']], [['validate']], [['format']], [['version']], [['--version']], [[]]])(
    '%j no se conecta: URL de relleno aunque las variables apunten al pooler',
    (args) => {
      expect(
        resolveCliDatasource(
          { NODE_ENV: 'production', DATABASE_URL: NEON_POOLER, DATABASE_DIRECT_URL: NEON_POOLER },
          argv(...args),
        ),
      ).toEqual({ url: OFFLINE_URL })
    },
  )

  it.each(['development', 'test', 'production', undefined])(
    'rechaza un host del pooler de Neon con NODE_ENV=%s, venga de la directa o de DATABASE_URL',
    (NODE_ENV) => {
      expect(
        errorOf(() =>
          resolveCliDatasource(
            { NODE_ENV, DATABASE_DIRECT_URL: NEON_POOLER },
            argv('migrate', 'deploy'),
          ),
        ),
      ).toContain('pooler')
      if (NODE_ENV !== 'production') {
        expect(
          errorOf(() =>
            resolveCliDatasource(
              { NODE_ENV, DATABASE_URL: NEON_POOLER },
              argv('migrate', 'status'),
            ),
          ),
        ).toContain('pooler')
      }
    },
  )

  it('la sombra tampoco puede ser el pooler', () => {
    expect(
      errorOf(() =>
        resolveCliDatasource(
          { DATABASE_DIRECT_URL: LOCAL, SHADOW_DATABASE_URL: NEON_POOLER },
          argv('migrate', 'diff'),
        ),
      ),
    ).toContain('pooler')
  })

  it.each([
    [['migrate', 'dev']],
    [['migrate', 'reset', '--force']],
    [['db', 'push']],
    [['--config', 'prisma.config.ts', 'migrate', 'dev']],
    [['migrate', '--name', 'x', 'dev']],
    [['migrate', 'algo-nuevo']],
    [['studio']],
  ])('%j se niega contra una base que no es local', (args) => {
    expect(
      errorOf(() => resolveCliDatasource({ DATABASE_DIRECT_URL: NEON_DIRECT }, argv(...args))),
    ).toMatch(/no es local/)
  })

  it.each([
    [['migrate', 'deploy']],
    [['migrate', 'status']],
    [['migrate', 'resolve', '--rolled-back', '20260926000000_x']],
    [['db', 'seed']],
  ])('%j sí corre contra la base remota por la URL directa', (args) => {
    expect(
      resolveCliDatasource(
        { NODE_ENV: 'production', DATABASE_DIRECT_URL: NEON_DIRECT },
        argv(...args),
      ),
    ).toEqual({ url: NEON_DIRECT })
  })

  it.each([
    'postgresql://a:b@localhost:5432/anticipate',
    'postgresql://a:b@127.0.0.2:5432/anticipate',
    'postgresql://a:b@[::1]:5432/anticipate',
    'postgresql://a:b@postgres:5432/anticipate',
    'postgresql://a:b@db.ejemplo.pe/anticipate?host=/var/run/postgresql',
  ])('migrate dev corre contra una base local (%s)', (url) => {
    expect(resolveCliDatasource({ DATABASE_DIRECT_URL: url }, argv('migrate', 'dev'))).toEqual({
      url,
    })
  })

  it.each([
    // La misma base escrita de otra forma: mayúsculas, puerto por defecto explícito, parámetros.
    ['postgresql://anticipate:anticipate@127.0.0.1:5433/anticipate?schema=public'],
    ['postgres://otro:otra@127.0.0.1:5433/anticipate'],
    ['postgresql://anticipate:anticipate@127.0.0.1:5433/%61nticipate'],
  ])('la sombra no puede ser la base que se migra aunque la URL difiera (%s)', (shadow) => {
    expect(
      errorOf(() =>
        resolveCliDatasource(
          { DATABASE_DIRECT_URL: LOCAL, SHADOW_DATABASE_URL: shadow },
          argv('migrate', 'dev'),
        ),
      ),
    ).toContain('SHADOW_DATABASE_URL')
  })

  it('compara el puerto por defecto con el explícito', () => {
    expect(
      errorOf(() =>
        resolveCliDatasource(
          {
            DATABASE_DIRECT_URL: 'postgresql://a:b@LOCALHOST/anticipate',
            SHADOW_DATABASE_URL: 'postgresql://a:b@localhost:5432/anticipate',
          },
          argv('migrate', 'diff'),
        ),
      ),
    ).toContain('SHADOW_DATABASE_URL')
  })

  it.each([
    'postgresql://a:b@localhost/anticipate?host=db.ejemplo.pe',
    'postgresql://a:b@localhost,db.ejemplo.pe/anticipate',
  ])('el host de los parámetros o una lista de hosts también cuentan (%s)', (url) => {
    expect(
      errorOf(() => resolveCliDatasource({ DATABASE_DIRECT_URL: url }, argv('migrate', 'dev'))),
    ).toMatch(/no es local/)
  })

  it('la sombra, que Prisma vacía cada vez, tiene que ser local', () => {
    expect(
      errorOf(() =>
        resolveCliDatasource(
          {
            DATABASE_DIRECT_URL: LOCAL,
            SHADOW_DATABASE_URL: 'postgresql://a:b@db.ejemplo.pe:5432/anticipate_shadow',
          },
          argv('migrate', 'diff'),
        ),
      ),
    ).toMatch(/SHADOW_DATABASE_URL.*no es local/)
  })

  it('una URL ilegible se rechaza sin repetirla (puede traer la contraseña)', () => {
    const message = errorOf(() =>
      resolveCliDatasource(
        { DATABASE_DIRECT_URL: 'no es una url secreta' },
        argv('migrate', 'deploy'),
      ),
    )
    expect(message).toContain('DATABASE_DIRECT_URL')
    expect(message).not.toContain('secreta')
  })

  it('los mensajes nunca repiten la contraseña', () => {
    const message = errorOf(() =>
      resolveCliDatasource({ DATABASE_DIRECT_URL: NEON_POOLER }, argv('migrate', 'deploy')),
    )
    expect(message).not.toContain('secreto')
  })
})
