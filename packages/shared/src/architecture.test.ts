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
}

type Edge = { file: string; domain: string; target: string; specifier: string; resolved: string }

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
function relativeSpecifiers(source: string): string[] {
  const patterns = [
    /from\s+(['"])([^'"]+)\1/g,
    /import\s+(['"])([^'"]+)\1/g,
    /import\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
  ]
  const specifiers: string[] = []
  for (const pattern of patterns) {
    for (const m of source.matchAll(pattern)) {
      const specifier = m[2] as string
      if (specifier.startsWith('./') || specifier.startsWith('../')) specifiers.push(specifier)
    }
  }
  return specifiers
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

describe('arquitectura de shared', () => {
  const edges = crossDomainImports()

  it('todo dominio está declarado en la tabla de dependencias', () => {
    const domains = readdirSync(SRC, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
    expect(domains.sort()).toEqual(Object.keys(ALLOWED).sort())
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
