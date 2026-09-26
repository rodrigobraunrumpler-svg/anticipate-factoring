/**
 * Guarda de la CLI de Prisma: qué URL usa cada comando y contra qué bases se niega a correr. La usa
 * `prisma.config.ts`; vive aquí, sin efectos al importarse, para poder probarla
 * (`cli-guard.test.ts`). Nunca incluye una URL en un mensaje: puede traer la contraseña.
 *
 * Reglas (docs/database/migrations.md):
 * 1. Un comando que no se conecta (`generate`, `validate`, `format`, `version`) recibe una URL de
 *    relleno: la imagen Docker genera el cliente sin base.
 * 2. La URL es siempre `DATABASE_DIRECT_URL` si existe. `DATABASE_URL` (la de la app, que en
 *    producción pasa por el pooler) solo se usa fuera de producción y si falta la directa.
 * 3. Nunca por el pooler de Neon (un host `*-pooler`), en ningún entorno: ni la base que se migra ni
 *    la sombra.
 * 4. Solo `migrate deploy`, `migrate status`, `migrate resolve`, `migrate diff` y `db seed` (que tiene
 *    su propia guarda) corren contra una base que no es local. `migrate dev`, `migrate reset`,
 *    `db push` y cualquier otro comando que se conecta, reconocido o no, exigen una base local.
 * 5. La sombra (`SHADOW_DATABASE_URL`), que Prisma vacía cada vez que la usa, tiene que ser local y
 *    nunca la misma base que se migra: se comparan host, puerto y base, no el texto de la URL.
 */

/** URL de relleno para los comandos que no se conectan. */
export const OFFLINE_URL = 'postgresql://sin-configurar@127.0.0.1:5432/sin-configurar'

/** Comandos (y banderas sueltas) que no abren una conexión. */
const OFFLINE_COMMANDS: ReadonlySet<string> = new Set([
  '',
  'generate',
  'validate',
  'format',
  'version',
  'debug',
  'help',
  'init',
])

/** Los únicos comandos que pueden conectarse a una base que no es local. */
const REMOTE_ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  'migrate deploy',
  'migrate status',
  'migrate resolve',
  'migrate diff',
  'db seed',
])

/** Comandos con subcomando: `migrate dev`, `db push`. */
const COMMANDS_WITH_SUBCOMMAND: ReadonlySet<string> = new Set(['migrate', 'db'])

/** Banderas globales que toman el valor en el argumento siguiente (`--config prisma.config.ts`). */
const VALUE_FLAGS: ReadonlySet<string> = new Set(['--config', '--schema'])

/** Hosts locales por nombre; además, todo 127.x.x.x y un socket Unix (`/var/run/postgresql`). */
const LOCAL_HOST_NAMES: ReadonlySet<string> = new Set(['localhost', '::1', 'postgres'])

const DEFAULT_PORT = '5432'

/**
 * El comando de la CLI a partir de `process.argv` (`migrate dev`, `db push`, `generate`, o `''`
 * sin comando), sin depender de su posición: salta las banderas y el valor de `--config` y
 * `--schema`. Un subcomando desconocido o mal ubicado se devuelve tal cual y, por la regla 4, exige
 * una base local.
 */
export function parsePrismaCommand(argv: readonly string[]): string {
  const positionals: string[] = []
  const args = argv.slice(2)
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ''
    if (arg.startsWith('-')) {
      if (VALUE_FLAGS.has(arg)) index++
      continue
    }
    positionals.push(arg)
  }
  const [command = '', subcommand] = positionals
  if (COMMANDS_WITH_SUBCOMMAND.has(command) && subcommand !== undefined) {
    return `${command} ${subcommand}`
  }
  return command
}

type Target = { hosts: string[]; port: string; database: string }

/** Host, puerto y base de una URL de PostgreSQL, en minúsculas y con el puerto por defecto. */
function targetOf(variable: string, value: string): Target {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${variable} no es una URL válida de PostgreSQL.`)
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error(`${variable} no es una URL de PostgreSQL (postgresql://).`)
  }
  // libpq: el parámetro `host` reemplaza al de la autoridad; varios hosts van separados por comas.
  const host = url.searchParams.get('host') ?? url.hostname
  const hosts = host
    .split(',')
    .map((name) =>
      name
        .trim()
        .toLowerCase()
        .replace(/^\[(.*)\]$/, '$1'),
    )
    .filter((name) => name !== '')
  if (hosts.length === 0) throw new Error(`${variable} no indica el host de la base.`)
  let database: string
  try {
    database = decodeURIComponent(url.pathname.slice(1))
  } catch {
    throw new Error(`${variable} tiene un nombre de base ilegible.`)
  }
  return { hosts, port: url.port || DEFAULT_PORT, database }
}

const isLocalHost = (host: string): boolean =>
  LOCAL_HOST_NAMES.has(host) || /^127(\.\d{1,3}){3}$/.test(host) || host.startsWith('/')

const isLocal = (target: Target): boolean => target.hosts.every(isLocalHost)

/** El pooler de Neon (PgBouncer en modo transacción): `ep-…-pooler.<región>.aws.neon.tech`. */
const isPooler = (target: Target): boolean =>
  target.hosts.some((host) => /-pooler(\.|$)/.test(host))

const sameDatabase = (a: Target, b: Target): boolean =>
  a.port === b.port &&
  a.database === b.database &&
  a.hosts.length === b.hosts.length &&
  a.hosts.every((host, index) => host === b.hosts[index])

/** La URL que usa la CLI (regla 2). */
function cliUrl(env: NodeJS.ProcessEnv): { variable: string; value: string } {
  const direct = env.DATABASE_DIRECT_URL?.trim()
  if (direct) return { variable: 'DATABASE_DIRECT_URL', value: direct }
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'Falta DATABASE_DIRECT_URL: en producción la CLI de Prisma nunca usa DATABASE_URL, que pasa por el pooler de Neon.',
    )
  }
  const url = env.DATABASE_URL?.trim()
  if (!url) throw new Error('Falta DATABASE_URL (o DATABASE_DIRECT_URL) para la CLI de Prisma.')
  return { variable: 'DATABASE_URL', value: url }
}

/**
 * El `datasource` de `prisma.config.ts` para el comando de `argv`, o un error en español que dice qué
 * regla se rompió. Ver las reglas al principio del archivo.
 */
export function resolveCliDatasource(
  env: NodeJS.ProcessEnv,
  argv: readonly string[],
): { url: string; shadowDatabaseUrl?: string } {
  const command = parsePrismaCommand(argv)
  if (OFFLINE_COMMANDS.has(command)) return { url: OFFLINE_URL }

  const { variable, value } = cliUrl(env)
  const target = targetOf(variable, value)
  if (isPooler(target)) {
    throw new Error(
      `${variable} apunta al pooler de Neon (host *-pooler): la CLI de Prisma nunca se conecta por el pooler. Usa la URL directa.`,
    )
  }
  if (!REMOTE_ALLOWED_COMMANDS.has(command) && !isLocal(target)) {
    throw new Error(
      `«prisma ${command}» solo corre contra una base local y ${variable} no es local: contra una base remota solo van migrate deploy, status, resolve y diff.`,
    )
  }

  const shadow = env.SHADOW_DATABASE_URL?.trim()
  if (!shadow) return { url: value }
  const shadowTarget = targetOf('SHADOW_DATABASE_URL', shadow)
  if (isPooler(shadowTarget)) {
    throw new Error('SHADOW_DATABASE_URL apunta al pooler de Neon: la sombra es una base local.')
  }
  if (!isLocal(shadowTarget)) {
    throw new Error(
      'SHADOW_DATABASE_URL no es local: Prisma vacía la base sombra cada vez que la usa.',
    )
  }
  if (sameDatabase(target, shadowTarget)) {
    throw new Error(
      `SHADOW_DATABASE_URL es la misma base que ${variable} (mismo host, puerto y base): Prisma la vacía cada vez que la usa.`,
    )
  }
  return { url: value, shadowDatabaseUrl: shadow }
}
