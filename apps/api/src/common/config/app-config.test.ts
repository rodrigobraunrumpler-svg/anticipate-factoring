import { availableParallelism } from 'node:os'
import { describe, expect, it } from 'vitest'
import { ConfigValidationError, parseConfig } from './app-config.js'
import { TURNSTILE_TEST_SECRET_KEYS } from './schemas/captcha.schema.js'
import { defaultXmlParseWorkers } from './schemas/xml-parser.schema.js'

/** Solo las variables obligatorias: todo lo demás toma su valor por defecto. */
const REQUIRED_ONLY = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://anticipate:anticipate@127.0.0.1:5432/anticipate',
  S3_BUCKET: 'anticipate-local',
  S3_ACCESS_KEY_ID: 'local',
  S3_SECRET_ACCESS_KEY: 'local',
  MAIL_TRANSPORT: 'fake',
  MAIL_FROM_EMAIL: 'solicitudes@anticipate.local',
  TEAM_NOTIFICATION_EMAIL: 'equipo@anticipate.local',
  ADMIN_BASE_URL: 'http://localhost:3000/',
  TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
}

/** Un entorno de producción que pasa todas las guardas. */
const PRODUCTION = {
  ...REQUIRED_ONLY,
  NODE_ENV: 'production',
  CORS_ORIGINS: 'https://anticipate.pe,https://admin.anticipate.pe',
  TRUST_PROXY: '172.17.0.1',
  TRUST_CLOUDFLARE_HEADERS: 'true',
  S3_ENDPOINT: 'https://cuenta.r2.cloudflarestorage.com',
  MAIL_TRANSPORT: 'brevo',
  BREVO_API_KEY: 'xkeysib-clave-de-produccion',
  ADMIN_BASE_URL: 'https://admin.anticipate.pe',
  TURNSTILE_SECRET_KEY: '0x4AAAAAAAclave-de-produccion',
  TURNSTILE_EXPECTED_HOSTNAME: 'anticipate.pe',
}

const PRODUCTION_ORIGIN_MESSAGE =
  'en producción cada origen debe ser https y no puede ser localhost ni una IP de loopback: son los de la landing y el admin publicados (https://anticipate.pe)'

const TURNSTILE_TEST_KEY_MESSAGE =
  'es una clave de prueba de Cloudflare: en producción usa la clave secreta del panel de Turnstile'

/** Cada guarda de producción: variable, valor que la dispara y mensaje. */
const PRODUCTION_GUARDS: ReadonlyArray<readonly [key: string, value: string, message: string]> = [
  ['MAIL_TRANSPORT', 'fake', 'no puede ser fake en producción: los correos se perderían sin aviso'],
  ...TURNSTILE_TEST_SECRET_KEYS.map(
    (key) => ['TURNSTILE_SECRET_KEY', key, TURNSTILE_TEST_KEY_MESSAGE] as const,
  ),
  // Los valores de desarrollo, un origen http o uno local: el navegador bloquearía cada envío de la
  // landing real sin que la API registre nada.
  ...[
    'http://localhost:4321,http://localhost:3000',
    'https://anticipate.pe,http://localhost:4321',
    'http://anticipate.pe',
    'https://localhost',
    'https://landing.localhost:8443',
    'https://127.0.0.1',
    'https://127.8.9.10:4321',
    'https://[::1]:4321',
    'https://0.0.0.0',
  ].map(
    (origins) =>
      ['CORS_ORIGINS', `https://anticipate.pe,${origins}`, PRODUCTION_ORIGIN_MESSAGE] as const,
  ),
]

/** Variables sin valor por defecto en producción: su valor de desarrollo rompe la API detrás de un proxy. */
const PRODUCTION_REQUIRED: ReadonlyArray<readonly [key: string, message: string]> = [
  [
    'CORS_ORIGINS',
    'es obligatoria en producción: los orígenes de la landing y del admin (https://anticipate.pe,https://admin.anticipate.pe); con los de desarrollo el navegador bloquea cada envío',
  ],
  [
    'TRUST_PROXY',
    'es obligatoria en producción: los proxies delante de la API (docs/STACK.md, sección 12); con el valor de desarrollo detrás de un proxy todos los visitantes comparten su IP (un solo cupo del límite de envíos y la IP del proxy en los consentimientos)',
  ],
  [
    'TRUST_CLOUDFLARE_HEADERS',
    'es obligatoria en producción: true si el servidor solo acepta tráfico de Cloudflare, false si no (docs/STACK.md, sección 12)',
  ],
]

/** Los problemas que reporta `parseConfig`; falla si la configuración es válida. */
function problemsOf(env: Record<string, string | undefined>): readonly string[] {
  try {
    parseConfig(env)
  } catch (error) {
    if (error instanceof ConfigValidationError) return error.problems
    throw error
  }
  throw new Error('parseConfig aceptó una configuración que debía rechazar')
}

describe('parseConfig', () => {
  it('aplica los valores por defecto de cada tema', () => {
    expect(parseConfig(REQUIRED_ONLY)).toEqual({
      nodeEnv: 'development',
      port: 4000,
      logLevel: 'info',
      publicCodePrefix: 'ANT',
      corsOrigins: ['http://localhost:4321', 'http://localhost:3000'],
      trustProxy: 'loopback',
      trustCloudflareHeaders: false,
      server: { requestTimeoutMs: 120_000, headersTimeoutMs: 20_000, keepAliveTimeoutMs: 65_000 },
      database: {
        url: 'postgresql://anticipate:anticipate@127.0.0.1:5432/anticipate',
        poolMax: 10,
        connectionTimeoutMs: 5_000,
        idleTimeoutMs: 30_000,
        transactionTimeoutMs: 15_000,
        transactionMaxWaitMs: 5_000,
      },
      storage: {
        endpoint: undefined,
        region: 'auto',
        bucket: 'anticipate-local',
        accessKeyId: 'local',
        secretAccessKey: 'local',
        forcePathStyle: true,
        orphanGraceMinutes: 60,
        deleteDelayDays: 35,
      },
      mail: {
        transport: 'fake',
        smtpHost: undefined,
        smtpPort: 1025,
        brevoApiKey: undefined,
        fromEmail: 'solicitudes@anticipate.local',
        fromName: 'Anticipate',
      },
      teamNotificationEmail: 'equipo@anticipate.local',
      adminBaseUrl: 'http://localhost:3000',
      turnstile: { secretKey: '1x0000000000000000000000000000000AA', expectedHostname: undefined },
      upload: {
        maxBodyBytes: 95_000_000,
        maxPdfBytes: 10_485_760,
        maxXmlBytes: 1_048_576,
        maxFiles: 20,
      },
      throttle: { defaultLimit: 120, defaultTtlMs: 60_000, submitLimit: 5, submitTtlMs: 3_600_000 },
      outbox: {
        pollerEnabled: true,
        pollIntervalMs: 5_000,
        batchSize: 20,
        leaseSeconds: 120,
        baseDelayMs: 30_000,
        maxDelayMs: 3_600_000,
        maxAttempts: 8,
        retentionDays: 30,
        purgeBatchSize: 500,
        handlerTimeoutMs: 20_000,
      },
      maintenance: { enabled: true, intervalMs: 3_600_000 },
      xmlParser: {
        workers: defaultXmlParseWorkers(availableParallelism()),
        timeoutMs: 2_000,
        workerHeapMb: 128,
        queueLimit: 32,
        queueTimeoutMs: 10_000,
      },
    })
  })

  it('el lector de XML usa por defecto un hilo menos que los núcleos, entre 1 y 4', () => {
    expect([1, 2, 3, 4, 5, 16, 64].map(defaultXmlParseWorkers)).toEqual([1, 1, 2, 3, 4, 4, 4])
  })

  it('XML_PARSE_*: lee cada tope y rechaza los que dejarían al lector sin hilos, sin plazo o sin memoria', () => {
    expect(
      parseConfig({
        ...REQUIRED_ONLY,
        XML_PARSE_WORKERS: '3',
        XML_PARSE_TIMEOUT_MS: '1500',
        XML_PARSE_WORKER_HEAP_MB: '256',
        XML_PARSE_QUEUE_LIMIT: '10',
        XML_PARSE_QUEUE_TIMEOUT_MS: '5000',
      }).xmlParser,
    ).toEqual({
      workers: 3,
      timeoutMs: 1_500,
      workerHeapMb: 256,
      queueLimit: 10,
      queueTimeoutMs: 5_000,
    })
    expect(
      problemsOf({
        ...REQUIRED_ONLY,
        XML_PARSE_WORKERS: '0',
        XML_PARSE_TIMEOUT_MS: '99',
        XML_PARSE_WORKER_HEAP_MB: '32',
        XML_PARSE_QUEUE_LIMIT: '0',
        XML_PARSE_QUEUE_TIMEOUT_MS: '120001',
      }),
    ).toEqual([
      'XML_PARSE_WORKERS: debe ser al menos 1',
      'XML_PARSE_TIMEOUT_MS: debe ser al menos 100',
      'XML_PARSE_WORKER_HEAP_MB: debe ser al menos 64',
      'XML_PARSE_QUEUE_LIMIT: debe ser al menos 1',
      'XML_PARSE_QUEUE_TIMEOUT_MS: debe ser como máximo 120000',
    ])
    expect(problemsOf({ ...REQUIRED_ONLY, XML_PARSE_WORKERS: '33' })).toEqual([
      'XML_PARSE_WORKERS: debe ser como máximo 32',
    ])
  })

  it('trata una variable vacía como ausente e ignora las que no conoce', () => {
    expect(problemsOf({ ...REQUIRED_ONLY, S3_BUCKET: '   ', OTRA_VARIABLE: 'x' })).toEqual([
      'S3_BUCKET: es obligatoria',
    ])
  })

  it('exige NODE_ENV: sin él un despliegue se saltaría las guardas de producción', () => {
    expect(problemsOf({ ...REQUIRED_ONLY, NODE_ENV: undefined })).toEqual([
      'NODE_ENV: debe ser development, test o production',
    ])
  })

  it('enumera en español cada variable inválida sin repetir su valor', () => {
    const env = {
      ...REQUIRED_ONLY,
      PORT: 'abc',
      TRUST_CLOUDFLARE_HEADERS: 'yes',
      DATABASE_URL: 'mysql://usuario:clave-secreta@db/app',
      MAIL_TRANSPORT: 'sendgrid',
    }
    expect(problemsOf(env)).toEqual([
      'PORT: debe ser un número entero',
      'TRUST_CLOUDFLARE_HEADERS: debe ser true o false',
      'DATABASE_URL: debe ser una URL postgresql:// con host y nombre de base de datos',
      'MAIL_TRANSPORT: debe ser smtp, brevo o fake',
    ])
    expect(() => parseConfig(env)).toThrow(/^Configuración inválida:\n- PORT/)
    expect(() => parseConfig(env)).not.toThrow(/clave-secreta/)
  })

  it('acepta solo enteros escritos en decimal y dentro de su rango', () => {
    for (const value of ['1e3', '12.5', '-1', '0x10']) {
      expect(problemsOf({ ...REQUIRED_ONLY, PORT: value })).toEqual([
        'PORT: debe ser un número entero',
      ])
    }
    expect(problemsOf({ ...REQUIRED_ONLY, PORT: '0' })).toEqual(['PORT: debe ser al menos 1'])
    expect(problemsOf({ ...REQUIRED_ONLY, PORT: '70000' })).toEqual([
      'PORT: debe ser como máximo 65535',
    ])
    expect(parseConfig({ ...REQUIRED_ONLY, PORT: ' 4001 ' }).port).toBe(4001)
  })

  it('TRUST_PROXY acepta false, un número de saltos o subredes, y nunca true', () => {
    expect(parseConfig({ ...REQUIRED_ONLY, TRUST_PROXY: 'false' }).trustProxy).toBe(false)
    expect(parseConfig({ ...REQUIRED_ONLY, TRUST_PROXY: '1' }).trustProxy).toBe(1)
    expect(parseConfig({ ...REQUIRED_ONLY, TRUST_PROXY: '10.0.0.0/8, loopback' }).trustProxy).toBe(
      '10.0.0.0/8,loopback',
    )
    for (const value of ['true', '10.0.0.0/33', 'proxy.interno']) {
      expect(problemsOf({ ...REQUIRED_ONLY, TRUST_PROXY: value })).toEqual([
        'TRUST_PROXY: debe ser false, el número de proxies delante de la API o una lista de subredes (loopback, 10.0.0.0/8); nunca true',
      ])
    }
  })

  it('CORS_ORIGINS acepta orígenes exactos, sin ruta ni barra final, y quita repetidos', () => {
    expect(
      parseConfig({
        ...REQUIRED_ONLY,
        CORS_ORIGINS: 'https://anticipate.pe, https://anticipate.pe,http://localhost:4321',
      }).corsOrigins,
    ).toEqual(['https://anticipate.pe', 'http://localhost:4321'])
    for (const value of [
      'https://anticipate.pe/',
      'https://anticipate.pe/landing',
      'anticipate.pe',
    ]) {
      expect(problemsOf({ ...REQUIRED_ONLY, CORS_ORIGINS: value })).toEqual([
        'CORS_ORIGINS: debe ser una lista de orígenes exactos separados por comas (https://anticipate.pe), sin ruta ni barra final',
      ])
    }
  })

  it('PUBLIC_CODE_PREFIX acepta lo mismo que el código público de shared', () => {
    expect(parseConfig({ ...REQUIRED_ONLY, PUBLIC_CODE_PREFIX: 'AF' }).publicCodePrefix).toBe('AF')
    for (const value of ['ant', 'ANTICIPA', 'A1', 'A']) {
      expect(problemsOf({ ...REQUIRED_ONLY, PUBLIC_CODE_PREFIX: value })).toEqual([
        'PUBLIC_CODE_PREFIX: debe tener de 2 a 6 letras mayúsculas (A-Z)',
      ])
    }
  })

  it('exige SMTP_HOST con smtp y BREVO_API_KEY con brevo', () => {
    expect(problemsOf({ ...REQUIRED_ONLY, MAIL_TRANSPORT: 'smtp' })).toEqual([
      'SMTP_HOST: es obligatoria con MAIL_TRANSPORT=smtp',
    ])
    expect(problemsOf({ ...REQUIRED_ONLY, MAIL_TRANSPORT: 'brevo' })).toEqual([
      'BREVO_API_KEY: es obligatoria con MAIL_TRANSPORT=brevo',
    ])
    expect(
      parseConfig({ ...REQUIRED_ONLY, MAIL_TRANSPORT: 'smtp', SMTP_HOST: '127.0.0.1' }).mail,
    ).toMatchObject({ transport: 'smtp', smtpHost: '127.0.0.1', smtpPort: 1025 })
  })

  it('una transacción de la API termina antes de que la base la corte por inactiva', () => {
    expect(problemsOf({ ...REQUIRED_ONLY, DATABASE_TRANSACTION_TIMEOUT_MS: '30000' })).toEqual([
      'DATABASE_TRANSACTION_TIMEOUT_MS: debe ser menor que 30000 (idle_in_transaction_session_timeout de la base)',
    ])
    expect(
      parseConfig({ ...REQUIRED_ONLY, DATABASE_TRANSACTION_TIMEOUT_MS: '29999' }).database
        .transactionTimeoutMs,
    ).toBe(29_999)
  })

  it('la base shadow nunca es la de la app ni la de las migraciones', () => {
    const app = 'postgresql://anticipate:anticipate@127.0.0.1:5432/anticipate'
    const message =
      'SHADOW_DATABASE_URL: debe apuntar a una base distinta de DATABASE_URL y DATABASE_DIRECT_URL: Prisma la vacía cada vez que la usa'
    expect(problemsOf({ ...REQUIRED_ONLY, SHADOW_DATABASE_URL: app })).toEqual([message])
    expect(
      problemsOf({
        ...REQUIRED_ONLY,
        DATABASE_DIRECT_URL: 'postgresql://owner:clave@db.interno:5432/anticipate',
        SHADOW_DATABASE_URL: 'postgresql://otro:otra@db.interno/anticipate',
      }),
    ).toEqual([message])
    expect(() =>
      parseConfig({
        ...REQUIRED_ONLY,
        SHADOW_DATABASE_URL: 'postgresql://anticipate:anticipate@127.0.0.1:5432/anticipate_shadow',
      }),
    ).not.toThrow()
  })

  it.each([
    // El mismo servidor local escrito de otra forma, otro puerto (Docker puede mapear dos al mismo
    // contenedor) o el nombre en mayúsculas: el nombre de la base basta para tratarlas como la misma.
    'postgresql://anticipate:anticipate@localhost:5432/anticipate',
    'postgresql://anticipate:anticipate@[::1]:5433/anticipate',
    'postgresql://otro:otra@127.0.0.1:5432/Anticipate?host=/var/run/postgresql',
  ])(
    'la base shadow con el mismo nombre de base que la de la app se rechaza, sea cual sea el host (%s)',
    (shadow) => {
      expect(problemsOf({ ...REQUIRED_ONLY, SHADOW_DATABASE_URL: shadow })).toEqual([
        'SHADOW_DATABASE_URL: debe apuntar a una base distinta de DATABASE_URL y DATABASE_DIRECT_URL: Prisma la vacía cada vez que la usa',
      ])
    },
  )

  it('las cabeceras no pueden esperar más que la petición entera', () => {
    expect(problemsOf({ ...REQUIRED_ONLY, SERVER_HEADERS_TIMEOUT_MS: '130000' })).toEqual([
      'SERVER_HEADERS_TIMEOUT_MS: debe ser menor o igual que SERVER_REQUEST_TIMEOUT_MS',
    ])
  })

  it('el tope de un handler del outbox cabe dos veces en el arriendo', () => {
    expect(problemsOf({ ...REQUIRED_ONLY, OUTBOX_HANDLER_TIMEOUT_MS: '60000' })).toEqual([
      'OUTBOX_HANDLER_TIMEOUT_MS: el doble debe ser menor que OUTBOX_LEASE_SECONDS (en milisegundos)',
    ])
    expect(
      parseConfig({ ...REQUIRED_ONLY, OUTBOX_HANDLER_TIMEOUT_MS: '59999' }).outbox.handlerTimeoutMs,
    ).toBe(59_999)
  })

  it('una configuración de producción completa pasa las guardas', () => {
    const config = parseConfig(PRODUCTION)
    expect(config.nodeEnv).toBe('production')
    expect(config.mail.transport).toBe('brevo')
  })

  it.each(PRODUCTION_GUARDS)('producción rechaza %s=%s', (key, value, message) => {
    expect(problemsOf({ ...PRODUCTION, [key]: value })).toEqual([`${key}: ${message}`])
  })

  it.each(PRODUCTION_REQUIRED)('producción exige %s explícita', (key, message) => {
    expect(problemsOf({ ...PRODUCTION, [key]: undefined })).toEqual([`${key}: ${message}`])
    // Vacía cuenta como ausente.
    expect(problemsOf({ ...PRODUCTION, [key]: '  ' })).toEqual([`${key}: ${message}`])
  })

  it('producción acepta cualquier decisión explícita sobre los proxies, también la de desarrollo', () => {
    for (const [trustProxy, expected] of [
      ['loopback', 'loopback'],
      ['false', false],
      ['1', 1],
      ['10.0.0.0/8', '10.0.0.0/8'],
    ] as const) {
      for (const trustCloudflareHeaders of ['true', 'false']) {
        const config = parseConfig({
          ...PRODUCTION,
          TRUST_PROXY: trustProxy,
          TRUST_CLOUDFLARE_HEADERS: trustCloudflareHeaders,
        })
        expect(config.trustProxy).toBe(expected)
        expect(config.trustCloudflareHeaders).toBe(trustCloudflareHeaders === 'true')
      }
    }
  })

  it('fuera de producción CORS_ORIGINS, TRUST_PROXY y TRUST_CLOUDFLARE_HEADERS conservan su valor de desarrollo', () => {
    for (const NODE_ENV of ['development', 'test']) {
      const config = parseConfig({ ...REQUIRED_ONLY, NODE_ENV })
      expect(config.corsOrigins).toEqual(['http://localhost:4321', 'http://localhost:3000'])
      expect(config.trustProxy).toBe('loopback')
      expect(config.trustCloudflareHeaders).toBe(false)
    }
  })

  it('TURNSTILE_EXPECTED_HOSTNAME se compara en minúsculas, como lo devuelve Cloudflare', () => {
    expect(
      parseConfig({ ...PRODUCTION, TURNSTILE_EXPECTED_HOSTNAME: 'Anticipate.PE' }).turnstile
        .expectedHostname,
    ).toBe('anticipate.pe')
  })

  it('en producción TURNSTILE_EXPECTED_HOSTNAME es el host de uno de los CORS_ORIGINS', () => {
    // El widget corre en la misma página que envía el formulario: su host es el del origen.
    expect(
      parseConfig({ ...PRODUCTION, TURNSTILE_EXPECTED_HOSTNAME: 'admin.anticipate.pe' }).turnstile
        .expectedHostname,
    ).toBe('admin.anticipate.pe')
    for (const hostname of ['anticipate.com', 'www.anticipate.pe', 'anticipate.pe.']) {
      expect(problemsOf({ ...PRODUCTION, TURNSTILE_EXPECTED_HOSTNAME: hostname })).toEqual([
        'TURNSTILE_EXPECTED_HOSTNAME: debe ser el host de uno de los CORS_ORIGINS (el de la landing): el widget corre en la página que envía el formulario, y con otro host cada envío recibe 403',
      ])
    }
    // Sin la variable no se compara el host, como en desarrollo.
    expect(
      parseConfig({ ...PRODUCTION, TURNSTILE_EXPECTED_HOSTNAME: undefined }).turnstile
        .expectedHostname,
    ).toBeUndefined()
  })

  it('producción acepta la infraestructura local de la imagen (pnpm api:image)', () => {
    // Los mismos valores que el servicio `api` de docker-compose.yml.
    const config = parseConfig({
      ...REQUIRED_ONLY,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://anticipate.test',
      TRUST_PROXY: 'false',
      TRUST_CLOUDFLARE_HEADERS: 'false',
      S3_ENDPOINT: 'http://s3mock:9090',
      MAIL_TRANSPORT: 'smtp',
      SMTP_HOST: 'mailpit',
      TURNSTILE_SECRET_KEY: 'local-image-smoke-test-not-a-secret',
    })
    expect(config.storage.endpoint).toBe('http://s3mock:9090')
    expect(config.corsOrigins).toEqual(['https://anticipate.test'])
    expect(config.trustProxy).toBe(false)
  })

  it('devuelve la configuración congelada: nadie la cambia después de arrancar', () => {
    const config = parseConfig(REQUIRED_ONLY)
    expect(Object.isFrozen(config)).toBe(true)
    expect(Object.isFrozen(config.outbox)).toBe(true)
    expect(Object.isFrozen(config.corsOrigins)).toBe(true)
    expect(() => {
      ;(config.outbox as { pollerEnabled: boolean }).pollerEnabled = false
    }).toThrow(TypeError)
  })
})
