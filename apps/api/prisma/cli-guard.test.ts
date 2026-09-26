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

  it.each([
    // Prisma se conecta al primer segmento de la ruta, y con el primero vacío a la base del usuario:
    // las dos sombras de abajo vaciarían `anticipate` aunque su nombre "parezca" otro.
    ['postgresql://anticipate:anticipate@localhost:5433/anticipate/shadow'],
    ['postgresql://anticipate:anticipate@localhost:5433//anticipate_shadow'],
    ['postgresql://anticipate:anticipate@localhost:5433/anticipate%2Fshadow'],
  ])('una sombra con más de un segmento en la ruta se rechaza: %s', (shadow) => {
    expect(
      errorOf(() =>
        resolveCliDatasource(
          { DATABASE_DIRECT_URL: LOCAL, SHADOW_DATABASE_URL: shadow },
          argv('migrate', 'diff', '--from-migrations', 'prisma/migrations', '--exit-code'),
        ),
      ),
    ).toMatch(/SHADOW_DATABASE_URL tiene una ruta con más de un segmento/)
  })

  it('la URL que se migra tampoco puede tener más de un segmento en la ruta', () => {
    expect(
      errorOf(() =>
        resolveCliDatasource(
          {
            DATABASE_DIRECT_URL: 'postgresql://anticipate:anticipate@127.0.0.1:5433/anticipate/x',
            SHADOW_DATABASE_URL: LOCAL_SHADOW,
          },
          argv('migrate', 'deploy'),
        ),
      ),
    ).toMatch(/DATABASE_DIRECT_URL tiene una ruta con más de un segmento/)
  })

  it('la sombra escrita con otro nombre del mismo servidor local sigue siendo la misma base (localhost y 127.0.0.1)', () => {
    // El caso que vació la base principal: db:check-drift con 127.0.0.1 en la directa y localhost
    // en la sombra, las dos en el mismo PostgreSQL.
    expect(
      errorOf(() =>
        resolveCliDatasource(
          {
            DATABASE_DIRECT_URL: 'postgresql://anticipate:anticipate@127.0.0.1:5433/anticipate',
            SHADOW_DATABASE_URL: 'postgresql://anticipate:anticipate@localhost:5433/anticipate',
          },
          argv('migrate', 'diff', '--from-migrations', 'prisma/migrations', '--exit-code'),
        ),
      ),
    ).toMatch(/SHADOW_DATABASE_URL nombra la misma base que DATABASE_DIRECT_URL/)
  })

  it.each([
    // Alias del mismo servidor local: loopback, IPv6, socket Unix y listas de hosts en otro orden.
    ['postgresql://a:b@localhost:5433/anticipate', 'postgresql://a:b@[::1]:5433/anticipate'],
    ['postgresql://a:b@127.0.0.1:5433/anticipate', 'postgresql://a:b@127.0.0.2:5433/anticipate'],
    [
      'postgresql://a:b@127.0.0.1:5433/anticipate',
      'postgresql://a:b@localhost:5433/anticipate?host=/var/run/postgresql',
    ],
    [
      'postgresql://a:b@localhost,127.0.0.1:5433/anticipate',
      'postgresql://a:b@127.0.0.1,localhost:5433/anticipate',
    ],
    // El servidor no se puede identificar por cómo se escribe: 127.1 y un nombre de /etc/hosts
    // llegan al loopback, y dos puertos de Docker pueden ir al mismo contenedor.
    ['postgresql://a:b@127.1:5433/anticipate', 'postgresql://a:b@localhost:5433/anticipate'],
    [
      'postgresql://a:b@mi-maquina.lan:5433/anticipate',
      'postgresql://a:b@127.0.0.1:5433/anticipate',
    ],
    ['postgresql://a:b@localhost:5433/anticipate', 'postgresql://a:b@localhost:5434/anticipate'],
    // Mayúsculas en el nombre: del lado seguro, se tratan como la misma base.
    ['postgresql://a:b@localhost:5433/anticipate', 'postgresql://a:b@localhost:5433/Anticipate'],
  ])(
    'la sombra con el mismo nombre de base se rechaza sin importar el host ni el puerto (%s, %s)',
    (main, shadow) => {
      expect(
        errorOf(() =>
          resolveCliDatasource(
            { DATABASE_DIRECT_URL: main, SHADOW_DATABASE_URL: shadow },
            argv('migrate', 'diff'),
          ),
        ),
      ).toMatch(/SHADOW_DATABASE_URL nombra la misma base/)
    },
  )

  it.each([
    // Una base con datos del mismo servidor, aunque no sea la que se migra: la de desarrollo
    // mientras se migra la de tests, o la de tests.
    [
      'postgresql://a:b@127.0.0.1:5433/anticipate_test',
      'postgresql://a:b@localhost:5433/anticipate',
    ],
    [
      'postgresql://a:b@127.0.0.1:5433/anticipate',
      'postgresql://a:b@127.0.0.1:5433/anticipate_test',
    ],
    ['postgresql://a:b@127.0.0.1:5433/anticipate', 'postgresql://a:b@127.0.0.1:5433/postgres'],
  ])(
    'la sombra tiene que ser una base desechable con «shadow» en el nombre (%s, %s)',
    (main, shadow) => {
      expect(
        errorOf(() =>
          resolveCliDatasource(
            { DATABASE_DIRECT_URL: main, SHADOW_DATABASE_URL: shadow },
            argv('migrate', 'dev'),
          ),
        ),
      ).toMatch(/SHADOW_DATABASE_URL.*«shadow» en el nombre/)
    },
  )

  it.each([
    [
      'DATABASE_DIRECT_URL',
      'postgresql://a:b@127.0.0.1:5433/anticipate_test?dbname=anticipate_shadow',
      LOCAL_SHADOW,
    ],
    [
      'SHADOW_DATABASE_URL',
      LOCAL,
      'postgresql://a:b@127.0.0.1:5433/anticipate_shadow?DBNAME=anticipate',
    ],
  ])(
    '%s no puede llevar la base en el parámetro dbname (libpq lo usa en vez de la ruta)',
    (variable, main, shadow) => {
      expect(
        errorOf(() =>
          resolveCliDatasource(
            { DATABASE_DIRECT_URL: main, SHADOW_DATABASE_URL: shadow },
            argv('migrate', 'diff'),
          ),
        ),
      ).toBe(`${variable} lleva el parámetro dbname: la base va solo en la ruta de la URL.`)
    },
  )

  it('con sombra, la URL que se migra tiene que nombrar su base (sin nombre, PostgreSQL usa el del usuario)', () => {
    expect(
      errorOf(() =>
        resolveCliDatasource(
          {
            DATABASE_DIRECT_URL: 'postgresql://anticipate_shadow:x@127.0.0.1:5433',
            SHADOW_DATABASE_URL: LOCAL_SHADOW,
          },
          argv('migrate', 'diff'),
        ),
      ),
    ).toMatch(/DATABASE_DIRECT_URL no nombra la base/)
  })

  it.each([
    [LOCAL, LOCAL_SHADOW, ['migrate', 'dev']],
    [LOCAL, 'postgresql://a:b@localhost:5433/Anticipate_Shadow', ['migrate', 'diff']],
    [NEON_DIRECT, 'postgresql://a:b@localhost:5433/neondb_shadow', ['migrate', 'diff']],
    [
      'postgresql://a:b@127.0.0.1:5433/anticipate_test',
      'postgresql://a:b@[::1]:5433/anticipate_shadow',
      ['migrate', 'diff'],
    ],
  ])(
    'una sombra local con «shadow» en el nombre y otro nombre de base pasa (%s, %s)',
    (main, shadow, args) => {
      expect(
        resolveCliDatasource(
          { DATABASE_DIRECT_URL: main, SHADOW_DATABASE_URL: shadow },
          argv(...args),
        ),
      ).toEqual({ url: main, shadowDatabaseUrl: shadow })
    },
  )

  it('con el mismo nombre de base, el puerto por defecto y el explícito tampoco la salvan', () => {
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
