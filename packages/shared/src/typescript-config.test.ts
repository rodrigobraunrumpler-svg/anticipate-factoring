import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Las dos configuraciones de TypeScript del paquete y lo que garantiza cada una:
 * - `tsconfig.src.json` compila el código de `src` (sin tests) sin tipos de Node ni del DOM, con
 *   `src/env.d.ts`: es la que sostiene el isomorfismo y la que usa tsdown para los `.d.ts`.
 * - `tsconfig.json` es la del editor y de los tests: VS Code abre cada archivo con el
 *   `tsconfig.json` más cercano que lo incluye, así que debe cubrir todo `.ts` del paquete con las
 *   opciones estrictas; un archivo que no incluye se abre en un proyecto inferido, sin ellas.
 * `pnpm typecheck` corre las dos.
 */

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
const ENV_DECLARATIONS = 'src/env.d.ts'

/** Ruta relativa al paquete, con `/` en cualquier sistema. */
const packagePath = (file: string): string => relative(PACKAGE_DIR, file).split(sep).join('/')

/** Todo `.ts` del paquete: `src`, `test` y los archivos de configuración de la raíz. */
function packageTsFiles(): string[] {
  const inDir = (dir: string) =>
    readdirSync(join(PACKAGE_DIR, dir), { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.ts'))
      .map((e) => packagePath(join(e.parentPath, e.name)))
  const atRoot = readdirSync(PACKAGE_DIR).filter((name) => name.endsWith('.ts'))
  return [...inDir('src'), ...inDir('test'), ...atRoot].sort()
}

function parseConfig(name: string): ts.ParsedCommandLine {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    join(PACKAGE_DIR, name),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
      },
    },
  )
  if (parsed === undefined) throw new Error(`No se pudo leer ${name}`)
  expect(parsed.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([])
  return parsed
}

const isTest = (file: string): boolean => file.endsWith('.test.ts')

/** Archivos raíz de una configuración (lo que resuelven `include` y `exclude`), sin prefijo. */
const filesOf = (config: ts.ParsedCommandLine): string[] => config.fileNames.map(packagePath).sort()

const STRICT = { strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true }

// Cada `it` lee su configuración: si una falla o falta, las comprobaciones de la otra siguen.
describe('configuración de TypeScript', () => {
  const all = packageTsFiles()

  it('tsconfig.json cubre todo `.ts` del paquete salvo `env.d.ts`, con tipos de Node', () => {
    const editor = parseConfig('tsconfig.json')
    expect(filesOf(editor)).toEqual(all.filter((file) => file !== ENV_DECLARATIONS))
    expect(editor.options.types).toEqual(['node'])
  })

  it('tsconfig.json aplica las opciones estrictas a los tests', () => {
    expect(parseConfig('tsconfig.json').options).toMatchObject(STRICT)
  })

  it('tsconfig.src.json compila solo el código de `src`, con `env.d.ts` y sin tests', () => {
    const files = filesOf(parseConfig('tsconfig.src.json'))
    expect(files).toEqual(all.filter((file) => file.startsWith('src/') && !isTest(file)))
    expect(files).toContain(ENV_DECLARATIONS)
  })

  it('tsconfig.src.json no trae tipos de Node ni del DOM y es estricta', () => {
    const { options } = parseConfig('tsconfig.src.json')
    expect(options.types).toEqual([])
    expect(options.lib).toEqual(['lib.es2022.d.ts'])
    expect(options).toMatchObject(STRICT)
  })

  it('entre las dos cubren todo `.ts` del paquete', () => {
    const covered = new Set([
      ...filesOf(parseConfig('tsconfig.json')),
      ...filesOf(parseConfig('tsconfig.src.json')),
    ])
    expect([...covered].sort()).toEqual(all)
  })
})
