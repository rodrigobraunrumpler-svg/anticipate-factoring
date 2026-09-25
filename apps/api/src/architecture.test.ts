import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, posix, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('.', import.meta.url))

/** Cliente generado por Prisma: no se clasifica, pero importarlo fuera de su lugar sí es violación. */
const GENERATED_DIR = 'infrastructure/prisma/generated/'

type Layer =
  | 'root'
  | 'bootstrap'
  | 'common'
  | 'infrastructure'
  | 'workers'
  | 'module-wiring'
  | 'domain'
  | 'application'
  | 'presentation'
  | 'health-checks'

type RuleId = Layer | 'unclassified' | 'restricted-dependency' | 'relative-escape' | 'own-barrel'

type SourceFile = { path: string; source: string }
type Violation = { rule: RuleId; file: string; specifier: string }

/**
 * Qué puede importar cada capa, como globs sobre rutas de `src` (`internal`) y sobre especificadores
 * de paquete (`packages`). `{module}` es el módulo del archivo (`modules/<module>/x.ts`) y `{worker}` su
 * carpeta en `workers/`. La tabla ya prevé los módulos y workers de las tareas siguientes: una capa
 * nueva o un permiso nuevo es una línea aquí, con su caso de violación abajo.
 */
const POLICIES: Record<Layer, { internal: readonly string[]; packages: readonly string[] }> = {
  // main.ts, app.module.ts y app.setup.ts: raíz de composición, puede importar cualquier cosa.
  root: { internal: ['**'], packages: ['**'] },
  // 9. bootstrap → common/**, @nestjs/* y paquetes de arranque; nunca modules/**.
  bootstrap: {
    internal: ['bootstrap/**', 'common/**'],
    packages: ['@nestjs/**', 'helmet', 'nestjs-pino', 'pino', 'pino-http', 'express', 'node:**'],
  },
  // 8. common → common/**, @nestjs/*, express, multer, @anticipate/shared/*, rxjs, node:*, helmet
  // y zod (la configuración); nunca modules/**, infrastructure/** ni workers/**.
  common: {
    internal: ['common/**'],
    packages: [
      '@nestjs/**',
      'express',
      'multer',
      '@anticipate/shared/*',
      'rxjs',
      'rxjs/**',
      'node:**',
      'helmet',
      'zod',
    ],
  },
  // 5. infrastructure → common/**, infrastructure/** y modules/*/index.ts; nunca presentation,
  // use-cases ni workers. Paquetes: cualquiera, salvo los de la regla 6 fuera de su lugar.
  infrastructure: {
    internal: ['common/**', 'infrastructure/**', 'modules/*/index.ts'],
    packages: ['**'],
  },
  // 7. workers → modules/*/index.ts, infrastructure/**/*.module.ts, infrastructure/*/index.ts,
  // common/** y @nestjs/*, además de su propia carpeta.
  workers: {
    internal: [
      'workers/{worker}/**',
      'modules/*/index.ts',
      'infrastructure/**/*.module.ts',
      'infrastructure/*/index.ts',
      'common/**',
    ],
    packages: ['@nestjs/**'],
  },
  // 4. module-wiring (modules/*/*.module.ts y modules/*/index.ts) → su módulo, common/**, @nestjs/*
  // e infrastructure/** (solo para cablear); de otro módulo, solo su index.ts (sus tokens).
  'module-wiring': {
    internal: ['modules/{module}/**', 'modules/*/index.ts', 'common/**', 'infrastructure/**'],
    packages: ['@nestjs/**'],
  },
  // 1. domain → su domain, common/exceptions, @anticipate/shared/* y node:crypto.
  domain: {
    internal: ['modules/{module}/domain/**', 'common/exceptions/**'],
    packages: ['@anticipate/shared/*', 'node:crypto'],
  },
  // 2. application → su domain y su application; otros módulos solo por su index.ts; de common solo
  // los archivos de error y de puerto de exceptions, storage, time y captcha; shared y emails.
  application: {
    internal: [
      'modules/{module}/domain/**',
      'modules/{module}/application/**',
      'modules/*/index.ts',
      'common/exceptions/**',
      'common/storage/file-storage.port.ts',
      'common/storage/index.ts',
      'common/time/clock.ts',
      'common/captcha/captcha-verifier.port.ts',
    ],
    packages: ['@anticipate/shared/*', '@anticipate/emails'],
  },
  // 3. presentation → su application (casos de uso y tipos, no puertos), su domain, common/**,
  // @nestjs/*, express y @anticipate/shared/*; nunca infrastructure/**.
  presentation: {
    internal: [
      'modules/{module}/presentation/**',
      'modules/{module}/application/use-cases/**',
      'modules/{module}/application/types/**',
      'modules/{module}/domain/**',
      'common/**',
    ],
    packages: ['@nestjs/**', 'express', '@anticipate/shared/*'],
  },
  // 10. health-checks (controlador de las sondas) → su carpeta, las rutas de bootstrap/constants.ts,
  // common/**, los indicadores de infrastructure/** y el index.ts de otro módulo; @nestjs/*.
  'health-checks': {
    internal: [
      'modules/health-checks/**',
      'bootstrap/constants.ts',
      'common/**',
      'infrastructure/**',
      'modules/*/index.ts',
    ],
    packages: ['@nestjs/**'],
  },
}

/** 6. Cada dependencia técnica tiene un único lugar, para cualquier capa (la raíz incluida). */
const RESTRICTED: readonly {
  kind: 'package' | 'internal'
  targets: readonly string[]
  onlyFrom: string
}[] = [
  { kind: 'package', targets: ['@prisma/**'], onlyFrom: 'infrastructure/prisma/**' },
  { kind: 'internal', targets: [`${GENERATED_DIR}**`], onlyFrom: 'infrastructure/prisma/**' },
  { kind: 'package', targets: ['@aws-sdk/**'], onlyFrom: 'infrastructure/storage/**' },
  {
    kind: 'package',
    targets: ['nodemailer', 'nodemailer/**'],
    onlyFrom: 'infrastructure/notifications/**',
  },
  { kind: 'package', targets: ['uuid', 'uuid/**'], onlyFrom: 'infrastructure/prisma/id.ts' },
]

function globToRegExp(glob: string): RegExp {
  const pattern = glob
    .replace(/[.+^$()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replaceAll('\u0000', '.*')
  return new RegExp(`^${pattern}$`)
}

const matches = (glob: string, value: string): boolean => globToRegExp(glob).test(value)

/** Capa de un archivo según su ruta relativa a `src` (con `/`), o `null` si no tiene. */
function classify(path: string): Layer | null {
  const parts = path.split('/')
  if (parts.length === 1) return 'root'
  const [top, name, area] = parts
  if (top === 'bootstrap') return 'bootstrap'
  if (top === 'common') return 'common'
  if (top === 'infrastructure') return 'infrastructure'
  if (top === 'workers' && parts.length >= 3) return 'workers'
  if (top !== 'modules' || name === undefined || area === undefined) return null
  if (parts.length === 3 && (area === 'index.ts' || area.endsWith('.module.ts')))
    return 'module-wiring'
  if (name === 'health-checks') return 'health-checks'
  if (area === 'domain' || area === 'application' || area === 'presentation') return area
  return null
}

/**
 * Zona de un archivo: la carpeta dentro de la cual un import puede ser relativo (`modules/<m>`,
 * `common/<x>`, `infrastructure/<x>`, `workers/<w>`, `bootstrap` o la raíz de `src`).
 */
function zoneOf(path: string): string {
  const parts = path.split('/')
  if (parts.length === 1) return '.'
  if (parts[0] === 'bootstrap') return 'bootstrap'
  return parts.slice(0, 2).join('/')
}

/** Especificadores de todas las formas de import: `from` (también `export { x } from`), de efecto, dinámico y `require`. */
function importSpecifiers(source: string): string[] {
  const patterns = [
    /from\s+(['"])([^'"]+)\1/g,
    /import\s+(['"])([^'"]+)\1/g,
    /import\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
    /require\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
  ]
  const specifiers: string[] = []
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[2] as string)
  }
  return specifiers
}

const isRelative = (specifier: string): boolean =>
  specifier.startsWith('./') || specifier.startsWith('../')

/** Ruta `.ts` dentro de `src` de un import `#/` o relativo; `null` si es un paquete. */
function resolveInternal(importer: string, specifier: string): string | null {
  let target: string
  if (specifier.startsWith('#/')) target = specifier.slice(2)
  else if (isRelative(specifier))
    target = posix.normalize(posix.join(posix.dirname(importer), specifier))
  else return null
  return target.replace(/\.js$/, '.ts')
}

/** Importar el `index.ts` de una carpeta que contiene al propio archivo: debe ir al archivo concreto. */
function isOwnBarrel(importer: string, target: string): boolean {
  if (posix.basename(target) !== 'index.ts' || importer === target) return false
  return importer.startsWith(`${posix.dirname(target)}/`)
}

function checkArchitecture(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = []
  for (const file of files) {
    const layer = classify(file.path)
    if (layer === null) {
      violations.push({ rule: 'unclassified', file: file.path, specifier: '' })
      continue
    }
    const segment = file.path.split('/')[1] ?? ''
    const allowedInternal = POLICIES[layer].internal.map((glob) =>
      glob.replaceAll('{module}', segment).replaceAll('{worker}', segment),
    )
    for (const specifier of importSpecifiers(file.source)) {
      const internal = resolveInternal(file.path, specifier)
      const kind = internal === null ? 'package' : 'internal'
      const target = internal ?? specifier
      const restricted = RESTRICTED.find(
        (rule) => rule.kind === kind && rule.targets.some((glob) => matches(glob, target)),
      )
      if (restricted !== undefined && !matches(restricted.onlyFrom, file.path)) {
        violations.push({ rule: 'restricted-dependency', file: file.path, specifier })
      }
      if (internal === null) {
        if (!POLICIES[layer].packages.some((glob) => matches(glob, specifier))) {
          violations.push({ rule: layer, file: file.path, specifier })
        }
        continue
      }
      if (isRelative(specifier) && zoneOf(internal) !== zoneOf(file.path)) {
        violations.push({ rule: 'relative-escape', file: file.path, specifier })
      }
      if (isOwnBarrel(file.path, internal)) {
        violations.push({ rule: 'own-barrel', file: file.path, specifier })
      }
      if (!allowedInternal.some((glob) => matches(glob, internal))) {
        violations.push({ rule: layer, file: file.path, specifier })
      }
    }
  }
  return violations
}

function readSourceFiles(): SourceFile[] {
  return readdirSync(SRC, { recursive: true, withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'),
    )
    .map((entry) => relative(SRC, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .filter((path) => !path.startsWith(GENERATED_DIR))
    .map((path) => ({ path, source: readFileSync(join(SRC, path), 'utf8') }))
}

describe('arquitectura de apps/api', () => {
  const files = readSourceFiles()

  it('todo archivo de src tiene capa', () => {
    expect(files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        'main.ts',
        'common/types/express.d.ts',
        'modules/health-checks/index.ts',
      ]),
    )
    const unclassified = files
      .filter((file) => classify(file.path) === null)
      .map((file) => file.path)
    expect(unclassified).toEqual([])
  })

  it('ningún import rompe las reglas de dependencia', () => {
    const violations = checkArchitecture(files)
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([])
  })

  it('no existe common/index.ts: cada carpeta de common es su propia frontera', () => {
    expect(existsSync(join(SRC, 'common', 'index.ts'))).toBe(false)
  })
})

describe('checkArchitecture detecta cada violación', () => {
  const cases: readonly { rule: RuleId; path: string; specifier: string }[] = [
    // 1. domain
    { rule: 'domain', path: 'modules/payers/domain/types/payer.ts', specifier: '@nestjs/common' },
    {
      rule: 'domain',
      path: 'modules/payers/domain/types/payer.ts',
      specifier: '#/modules/payers/application/use-cases/list-public-payers.use-case.js',
    },
    // 2. application
    {
      rule: 'application',
      path: 'modules/payers/application/use-cases/list-public-payers.use-case.ts',
      specifier: '#/infrastructure/prisma/prisma.service.js',
    },
    {
      rule: 'application',
      path: 'modules/advance-requests/application/use-cases/create-advance-request.use-case.ts',
      specifier: '#/modules/outbox/application/ports/outbox-event-repository.port.js',
    },
    {
      rule: 'application',
      path: 'modules/advance-requests/application/services/invoice-intake.service.ts',
      specifier: '@nestjs/common',
    },
    {
      rule: 'application',
      path: 'modules/advance-requests/application/use-cases/create-advance-request.use-case.ts',
      specifier: '#/common/captcha/captcha.guard.js',
    },
    // 3. presentation
    {
      rule: 'presentation',
      path: 'modules/payers/presentation/http/controllers/payers.controller.ts',
      specifier: '#/modules/payers/application/ports/payer-repository.port.js',
    },
    {
      rule: 'presentation',
      path: 'modules/payers/presentation/http/controllers/payers.controller.ts',
      specifier: '#/infrastructure/prisma/repositories/payers/prisma-payer.repository.js',
    },
    // 4. module-wiring
    {
      rule: 'module-wiring',
      path: 'modules/payers/payers.module.ts',
      specifier: '#/modules/outbox/application/use-cases/publish-outbox-events.use-case.js',
    },
    {
      rule: 'module-wiring',
      path: 'modules/payers/payers.module.ts',
      specifier: '#/workers/outbox-publisher/outbox-publisher.module.js',
    },
    // 5. infrastructure
    {
      rule: 'infrastructure',
      path: 'infrastructure/prisma/repositories/payers/prisma-payer.repository.ts',
      specifier: '#/modules/payers/application/use-cases/list-public-payers.use-case.js',
    },
    {
      rule: 'infrastructure',
      path: 'infrastructure/prisma/repositories/outbox/prisma-outbox-event.repository.ts',
      specifier: '#/workers/outbox-publisher/outbox-publisher.scheduler.js',
    },
    // 6. dependencias técnicas fuera de su lugar
    {
      rule: 'restricted-dependency',
      path: 'infrastructure/storage/s3/s3-file-storage.adapter.ts',
      specifier: '@prisma/client',
    },
    {
      rule: 'restricted-dependency',
      path: 'app.module.ts',
      specifier: '#/infrastructure/prisma/generated/client.js',
    },
    {
      rule: 'restricted-dependency',
      path: 'infrastructure/notifications/brevo/brevo-email-sender.adapter.ts',
      specifier: '@aws-sdk/client-s3',
    },
    {
      rule: 'restricted-dependency',
      path: 'infrastructure/storage/s3/s3-file-storage.adapter.ts',
      specifier: 'nodemailer',
    },
    {
      rule: 'restricted-dependency',
      path: 'infrastructure/prisma/prisma.service.ts',
      specifier: 'uuid',
    },
    // 7. workers
    {
      rule: 'workers',
      path: 'workers/outbox-publisher/outbox-publisher.scheduler.ts',
      specifier: '#/modules/outbox/application/use-cases/publish-outbox-events.use-case.js',
    },
    {
      rule: 'workers',
      path: 'workers/maintenance/maintenance.scheduler.ts',
      specifier: '#/infrastructure/prisma/prisma.service.js',
    },
    {
      rule: 'workers',
      path: 'workers/maintenance/maintenance.scheduler.ts',
      specifier: '#/workers/outbox-publisher/outbox-publisher.scheduler.js',
    },
    // 8. common
    {
      rule: 'common',
      path: 'common/filters/all-exceptions.filter.ts',
      specifier: '#/modules/payers/index.js',
    },
    {
      rule: 'common',
      path: 'common/guards/app-throttler.guard.ts',
      specifier: '#/infrastructure/time/index.js',
    },
    { rule: 'common', path: 'common/utils/client-ip.ts', specifier: 'pino' },
    // 9. bootstrap
    {
      rule: 'bootstrap',
      path: 'bootstrap/swagger.setup.ts',
      specifier: '#/modules/payers/index.js',
    },
    // 10. health-checks
    {
      rule: 'health-checks',
      path: 'modules/health-checks/controllers/health.controller.ts',
      specifier: '#/modules/payers/application/use-cases/list-public-payers.use-case.js',
    },
    // Estructura: import relativo que sale de su zona y import del propio barril.
    {
      rule: 'relative-escape',
      path: 'modules/payers/application/use-cases/list-public-payers.use-case.ts',
      specifier: '../../../../common/time/clock.js',
    },
    {
      rule: 'own-barrel',
      path: 'modules/payers/application/use-cases/list-public-payers.use-case.ts',
      specifier: '#/modules/payers/index.js',
    },
  ]

  it.each(cases)('$rule: $path importa $specifier', ({ rule, path, specifier }) => {
    const source = `import { x } from '${specifier}'\n`
    expect(checkArchitecture([{ path, source }])).toContainEqual({ rule, file: path, specifier })
  })

  it('unclassified: un archivo fuera de las capas conocidas', () => {
    expect(checkArchitecture([{ path: 'modules/payers/helpers/format.ts', source: '' }])).toEqual([
      { rule: 'unclassified', file: 'modules/payers/helpers/format.ts', specifier: '' },
    ])
  })

  it('un árbol que respeta las reglas no tiene violaciones, incluidos los módulos por venir', () => {
    const tree: SourceFile[] = [
      {
        path: 'modules/advance-requests/domain/services/request-fingerprint.ts',
        source:
          "import { createHash } from 'node:crypto'\nimport type { Amount } from '@anticipate/shared/money'\nimport { IdempotencyKeyReusedError } from '../exceptions/idempotency-key-reused.error.js'\nimport { ApplicationError } from '#/common/exceptions/index.js'\n",
      },
      {
        path: 'modules/advance-requests/application/use-cases/create-advance-request.use-case.ts',
        source:
          "import type { Clock } from '#/common/time/clock.js'\nimport type { FileStoragePort } from '#/common/storage/index.js'\nimport { ServiceUnavailableError } from '#/common/exceptions/index.js'\nimport type { OutboxWakeUpSignal } from '#/modules/outbox/index.js'\nimport { buildStorageKeys } from '../../domain/services/storage-keys.js'\nimport type { AdvanceRequestRepositoryPort } from '../ports/advance-request-repository.port.js'\nimport { renderAdvanceRequestConfirmation } from '@anticipate/emails'\nimport { todayIn } from '@anticipate/shared/dates'\n",
      },
      {
        path: 'modules/advance-requests/presentation/http/controllers/advance-requests.controller.ts',
        source:
          "import { Controller } from '@nestjs/common'\nimport type { Request } from 'express'\nimport { CreateAdvanceRequestUseCase } from '../../../application/use-cases/create-advance-request.use-case.js'\nimport { SubmitThrottle } from '#/common/decorators/submit-throttle.decorator.js'\nimport { SUCCESS_MESSAGES_ES } from '@anticipate/shared/api'\n",
      },
      {
        path: 'modules/advance-requests/advance-requests.module.ts',
        source:
          "import { Module } from '@nestjs/common'\nimport { APP_CONFIG } from '#/common/config/index.js'\nimport { AdvanceRequestsPersistenceModule } from '#/infrastructure/prisma/repositories/advance-requests/advance-requests-persistence.module.js'\nimport { OUTBOX_WAKE_UP } from '#/modules/outbox/index.js'\nimport { CreateAdvanceRequestUseCase } from './application/use-cases/create-advance-request.use-case.js'\n",
      },
      {
        path: 'infrastructure/prisma/repositories/payers/prisma-payer.repository.ts',
        source:
          "import { Injectable } from '@nestjs/common'\nimport type { PayerRepositoryPort } from '#/modules/payers/index.js'\nimport { PrismaService } from '../../prisma.service.js'\nimport type { Prisma } from '../../generated/client.js'\n",
      },
      {
        path: 'infrastructure/prisma/id.ts',
        source: "import { v7 } from 'uuid'\n",
      },
      {
        path: 'workers/outbox-publisher/outbox-publisher.module.ts',
        source:
          "import { Module } from '@nestjs/common'\nimport { PublishOutboxEventsUseCase } from '#/modules/outbox/index.js'\nimport { OutboxPersistenceModule } from '#/infrastructure/prisma/repositories/outbox/outbox-persistence.module.js'\nimport { TimeModule } from '#/infrastructure/time/index.js'\nimport { OutboxPublisherScheduler } from './outbox-publisher.scheduler.js'\n",
      },
      {
        path: 'modules/health-checks/controllers/health.controller.ts',
        source:
          "import { Controller } from '@nestjs/common'\nimport { HEALTH_PATHS } from '#/bootstrap/constants.js'\n",
      },
      {
        path: 'bootstrap/pino-http.options.ts',
        source:
          "import type { Params } from 'nestjs-pino'\nimport { resolveCorrelationId } from '#/common/utils/correlation-id.js'\nimport { HEALTH_PATHS } from './constants.js'\n",
      },
      {
        path: 'common/guards/app-throttler.guard.ts',
        source:
          "import { ThrottlerGuard } from '@nestjs/throttler'\nimport { APP_CONFIG } from '#/common/config/index.js'\n",
      },
      {
        path: 'app.module.ts',
        source:
          "import { LoggerModule } from 'nestjs-pino'\nimport { HealthChecksModule } from '#/modules/health-checks/index.js'\nimport { AppConfigModule } from '#/common/config/index.js'\n",
      },
    ]
    expect(checkArchitecture(tree)).toEqual([])
  })
})

describe('lectura y resolución de imports', () => {
  it('lee from, export from, import de efecto, dinámico y require', () => {
    const source = [
      "import { a } from '#/common/a.js'",
      'import type { B } from "./b.js"',
      "export { c } from '../c.js'",
      "import 'reflect-metadata'",
      "const d = await import('#/common/d.js')",
      "const e = require('node:fs')",
    ].join('\n')
    expect(importSpecifiers(source).sort()).toEqual(
      ['#/common/a.js', '#/common/d.js', '../c.js', './b.js', 'node:fs', 'reflect-metadata'].sort(),
    )
  })

  it('resuelve #/ y relativos a rutas .ts de src, y deja los paquetes afuera', () => {
    expect(resolveInternal('app.module.ts', '#/common/config/index.js')).toBe(
      'common/config/index.ts',
    )
    expect(resolveInternal('modules/payers/application/use-cases/x.ts', '../ports/y.port.js')).toBe(
      'modules/payers/application/ports/y.port.ts',
    )
    expect(resolveInternal('app.module.ts', '@nestjs/common')).toBeNull()
  })

  it.each([
    ['main.ts', 'root'],
    ['bootstrap/constants.ts', 'bootstrap'],
    ['common/config/schemas/http.schema.ts', 'common'],
    ['common/types/express.d.ts', 'common'],
    ['infrastructure/time/time.module.ts', 'infrastructure'],
    ['workers/outbox-publisher/outbox-publisher.scheduler.ts', 'workers'],
    ['modules/payers/payers.module.ts', 'module-wiring'],
    ['modules/payers/index.ts', 'module-wiring'],
    ['modules/health-checks/health-checks.module.ts', 'module-wiring'],
    ['modules/health-checks/controllers/health.controller.ts', 'health-checks'],
    ['modules/outbox/domain/services/outbox-backoff.ts', 'domain'],
    ['modules/outbox/application/use-cases/publish-outbox-events.use-case.ts', 'application'],
    ['modules/payers/presentation/http/controllers/payers.controller.ts', 'presentation'],
    ['modules/payers/helpers/format.ts', null],
    ['workers/sueltos.ts', null],
  ])('clasifica %s como %s', (path, layer) => {
    expect(classify(path)).toBe(layer)
  })
})
