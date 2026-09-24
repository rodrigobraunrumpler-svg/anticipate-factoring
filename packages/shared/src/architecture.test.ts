import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('.', import.meta.url))

/**
 * Qué dominios puede importar cada dominio. Agregar un dominio = agregar su fila; el test falla si
 * falta. `errors` es la capa base (códigos, `Problem` y todo el texto en español) y cualquier dominio
 * puede importarla; ella no importa a nadie, así que no crea ciclos.
 */
const ALLOWED: Record<string, readonly string[]> = {
  errors: [],
  identity: ['errors'],
  money: ['errors'],
  dates: ['errors'],
  user: ['errors'],
  invoice: ['errors', 'money', 'dates'],
  'advance-request': ['errors', 'identity', 'money', 'dates', 'user', 'payer'],
  'supplier-document': ['errors', 'dates'],
  payer: ['errors', 'identity', 'money'],
  // Fábrica de XML de prueba (`@anticipate/shared/testing`): no depende de nadie y ningún dominio de
  // producción la importa.
  testing: [],
}

/**
 * Paquetes de npm que puede importar cada dominio, además de `zod` (permitido en todos). `shared` es
 * isomorfo (landing, admin y API): ningún dominio importa módulos de Node (`node:…`) ni paquetes que
 * no estén en `dependencies` de package.json. Agregar una dependencia = declararla aquí en su dominio.
 */
const PACKAGES_FOR_ALL = ['zod'] as const
const ALLOWED_PACKAGES: Record<string, readonly string[]> = {
  money: ['decimal.js'],
  dates: ['date-fns', '@date-fns/tz'],
  invoice: ['fast-xml-parser'],
}

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  dependencies?: Record<string, string>
}
const DEPENDENCIES = new Set(Object.keys(packageJson.dependencies ?? {}))

type Edge = { file: string; domain: string; target: string; specifier: string; resolved: string }
type PackageImport = { file: string; domain: string; specifier: string; packageName: string }

function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
    .map((e) => join(e.parentPath, e.name))
}

/**
 * Especificadores relativos (`./…` o `../…`) de las cuatro formas de import de ES que puede traer un
 * archivo de `shared`: estático con `from` (comilla simple o doble), de efecto sin `from`
 * (`import '../x/index.js'`) y dinámico (`import('../x/index.js')`). Ignora los especificadores de
 * paquete (`'zod'`): esos nunca cruzan un dominio de `shared`.
 */
function allSpecifiers(source: string): string[] {
  const patterns = [
    /from\s+(['"])([^'"]+)\1/g,
    /import\s+(['"])([^'"]+)\1/g,
    /import\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
    /require\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
  ]
  const specifiers: string[] = []
  for (const pattern of patterns) {
    for (const m of source.matchAll(pattern)) specifiers.push(m[2] as string)
  }
  return specifiers
}

const isRelative = (specifier: string) => specifier.startsWith('./') || specifier.startsWith('../')

function relativeSpecifiers(source: string): string[] {
  return allSpecifiers(source).filter(isRelative)
}

/** Especificadores de paquete (`'zod'`, `'@date-fns/tz'`, `'node:fs'`, `'fs'`): todo lo que no es relativo. */
function packageSpecifiers(source: string): string[] {
  return allSpecifiers(source).filter((specifier) => !isRelative(specifier))
}

/** Nombre del paquete de un especificador: `@scope/name` o el primer segmento (`date-fns/locale` → `date-fns`). */
function packageNameOf(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] as string)
}

/**
 * Directivas triple barra `/// <reference …>` de un archivo (`types`, `lib`, `path` o cualquier otra).
 * Traen tipos sin pasar por un import: `/// <reference types="node" />` devuelve los globales de Node
 * (`process`, `Buffer`) a todo el programa, así que `tsc` y los tests de imports no las ven. Una línea
 * que solo empieza con `///` sin `<reference` es un comentario común y no cuenta.
 */
function referenceDirectives(source: string): string[] {
  const pattern = /^\uFEFF?[ \t]*(\/\/\/[ \t]*<reference\b[^>]*>)/gm
  return [...source.matchAll(pattern)].map((m) => m[1] as string)
}

function crossDomainImports(): Edge[] {
  const edges: Edge[] = []
  for (const file of sourceFiles()) {
    const fileRelative = relative(SRC, file)
    const parts = fileRelative.split(sep)
    if (parts.length < 2) continue // index.ts de la raíz: reexporta todo a propósito
    const domain = parts[0] as string
    const source = readFileSync(file, 'utf8')
    for (const specifier of relativeSpecifiers(source)) {
      const resolved = relative(SRC, resolve(dirname(file), specifier))
      const target = resolved.split(sep)[0] as string
      if (target === domain) continue // import dentro del mismo dominio, aunque suba y baje niveles
      edges.push({ file: fileRelative, domain, target, specifier, resolved })
    }
  }
  return edges
}

function packageImports(): PackageImport[] {
  const imports: PackageImport[] = []
  for (const file of sourceFiles()) {
    const fileRelative = relative(SRC, file)
    const domain = fileRelative.split(sep).length < 2 ? '' : (fileRelative.split(sep)[0] as string)
    for (const specifier of packageSpecifiers(readFileSync(file, 'utf8'))) {
      imports.push({ file: fileRelative, domain, specifier, packageName: packageNameOf(specifier) })
    }
  }
  return imports
}

describe('arquitectura de shared', () => {
  const edges = crossDomainImports()
  const packages = packageImports()

  it('todo dominio está declarado en la tabla de dependencias', () => {
    const domains = readdirSync(SRC, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
    expect(domains.sort()).toEqual(Object.keys(ALLOWED).sort())
  })

  it('ningún dominio de producción importa la fábrica de prueba, y el índice raíz no la exporta', () => {
    expect(edges.filter((e) => e.target === 'testing')).toEqual([])
    expect(readFileSync(join(SRC, 'index.ts'), 'utf8')).not.toContain('testing')
  })

  it('los imports entre dominios pasan por el index del dominio destino', () => {
    const bad = edges.filter(
      (e) =>
        e.resolved !== `${e.target}${sep}index.js` && e.resolved !== `${e.target}${sep}index.ts`,
    )
    expect(bad, JSON.stringify(bad, null, 2)).toEqual([])
  })

  it('cada dominio solo importa lo que la tabla permite', () => {
    const bad = edges.filter((e) => !(ALLOWED[e.domain] ?? []).includes(e.target))
    expect(bad, JSON.stringify(bad, null, 2)).toEqual([])
  })

  it('ningún archivo de código importa módulos de Node (`node:…`)', () => {
    const bad = packages.filter((p) => p.specifier.startsWith('node:'))
    expect(bad, JSON.stringify(bad, null, 2)).toEqual([])
  })

  it('ningún archivo de código trae tipos con una directiva triple barra (`/// <reference …>`)', () => {
    const bad = sourceFiles().flatMap((file) =>
      referenceDirectives(readFileSync(file, 'utf8')).map((directive) => ({
        file: relative(SRC, file),
        directive,
      })),
    )
    expect(bad, JSON.stringify(bad, null, 2)).toEqual([])
  })

  it('ningún archivo de código cambia la configuración global de Zod (`z.config`)', () => {
    // Cada app activa `z.config(z.locales.es())` al arrancar; `shared` trae sus propios mensajes y
    // no toca la configuración del proceso que lo importa.
    const bad = sourceFiles()
      .filter((file) => /\bconfig\s*\(/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file))
    expect(bad).toEqual([])
  })

  it('todo paquete importado está en `dependencies` de package.json', () => {
    const bad = packages.filter((p) => !DEPENDENCIES.has(p.packageName))
    expect(bad, JSON.stringify(bad, null, 2)).toEqual([])
  })

  it('cada dominio solo importa los paquetes que tiene permitidos', () => {
    const bad = packages.filter(
      (p) =>
        !(PACKAGES_FOR_ALL as readonly string[]).includes(p.packageName) &&
        !(ALLOWED_PACKAGES[p.domain] ?? []).includes(p.packageName),
    )
    expect(bad, JSON.stringify(bad, null, 2)).toEqual([])
  })

  it('toda dependencia de runtime está asignada a algún dominio', () => {
    const assigned = new Set([...PACKAGES_FOR_ALL, ...Object.values(ALLOWED_PACKAGES).flat()])
    expect([...DEPENDENCIES].filter((d) => !assigned.has(d))).toEqual([])
    expect(Object.keys(ALLOWED_PACKAGES).every((d) => Object.hasOwn(ALLOWED, d))).toBe(true)
  })

  it('la tabla no tiene ciclos', () => {
    const visit = (domain: string, stack: string[]): void => {
      if (stack.includes(domain)) throw new Error(`Ciclo: ${[...stack, domain].join(' -> ')}`)
      for (const next of ALLOWED[domain] ?? []) visit(next, [...stack, domain])
    }
    for (const domain of Object.keys(ALLOWED)) visit(domain, [])
  })
})

describe('relativeSpecifiers', () => {
  it('detecta "from \'...\'"', () => {
    expect(relativeSpecifiers("import { a } from '../mod/index.js'")).toEqual(['../mod/index.js'])
  })

  it('detecta \'from "..."\'', () => {
    expect(relativeSpecifiers('import { a } from "../mod/index.js"')).toEqual(['../mod/index.js'])
  })

  it('detecta un import de efecto sin from, en ambas comillas', () => {
    expect(relativeSpecifiers("import '../mod/index.js'")).toEqual(['../mod/index.js'])
    expect(relativeSpecifiers('import "../mod/index.js"')).toEqual(['../mod/index.js'])
  })

  it('detecta un import dinámico, en ambas comillas', () => {
    expect(relativeSpecifiers("const m = await import('../mod/index.js')")).toEqual([
      '../mod/index.js',
    ])
    expect(relativeSpecifiers('import("../mod/index.js")')).toEqual(['../mod/index.js'])
  })

  it('ignora especificadores que no son relativos', () => {
    expect(relativeSpecifiers("import { z } from 'zod'")).toEqual([])
  })
})

describe('packageSpecifiers y packageNameOf', () => {
  it('detecta paquetes, módulos de Node y require', () => {
    expect(
      packageSpecifiers(
        "import { z } from 'zod'\nimport fs from 'node:fs'\nconst p = require('path')\nimport '../x/index.js'",
      ),
    ).toEqual(['zod', 'node:fs', 'path'])
  })

  it('obtiene el nombre del paquete con y sin scope', () => {
    expect(packageNameOf('@date-fns/tz')).toBe('@date-fns/tz')
    expect(packageNameOf('date-fns/locale')).toBe('date-fns')
    expect(packageNameOf('node:fs')).toBe('node:fs')
  })
})

describe('referenceDirectives', () => {
  it('detecta las directivas de tipos, de lib y de ruta, en ambas comillas y sin espacios', () => {
    const source = [
      '/// <reference types="node" />',
      "/// <reference lib='dom' />",
      '///<reference path="../globals.d.ts"/>',
      '  /// <reference types="bun-types" />',
      "import { z } from 'zod'",
    ].join('\n')
    expect(referenceDirectives(source)).toEqual([
      '/// <reference types="node" />',
      "/// <reference lib='dom' />",
      '///<reference path="../globals.d.ts"/>',
      '/// <reference types="bun-types" />',
    ])
  })

  it('detecta cualquier otra directiva `reference`, como `no-default-lib`', () => {
    expect(referenceDirectives('/// <reference no-default-lib="true"/>')).toEqual([
      '/// <reference no-default-lib="true"/>',
    ])
  })

  it('detecta la directiva al inicio de un archivo con BOM', () => {
    expect(referenceDirectives('\uFEFF/// <reference types="node" />\n')).toEqual([
      '/// <reference types="node" />',
    ])
  })

  it('ignora comentarios que solo la mencionan', () => {
    const source = [
      '// Nunca uses /// <reference types="node" /> en shared.',
      ' * `/// <reference lib="dom" />` devolvería los globales del DOM.',
      '/// Comentario de tres barras sin directiva.',
    ].join('\n')
    expect(referenceDirectives(source)).toEqual([])
  })
})
