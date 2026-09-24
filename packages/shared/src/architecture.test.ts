import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('.', import.meta.url))

/** Qué dominios puede importar cada dominio. Agregar un dominio = agregar su fila; el test falla si falta. */
const ALLOWED: Record<string, readonly string[]> = {
  errors: [],
  identity: ['errors'],
  money: ['errors'],
  dates: [],
  user: [],
  invoice: ['errors', 'money', 'dates'],
  'advance-request': ['identity', 'money', 'dates', 'user'],
  'supplier-document': ['dates'],
  payer: ['identity', 'money'],
}

type Edge = { file: string; domain: string; target: string; specifier: string }

function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
    .map((e) => join(e.parentPath, e.name))
}

function crossDomainImports(): Edge[] {
  const edges: Edge[] = []
  for (const file of sourceFiles()) {
    const parts = relative(SRC, file).split(sep)
    if (parts.length < 2) continue // index.ts de la raíz: reexporta todo a propósito
    const domain = parts[0] as string
    const source = readFileSync(file, 'utf8')
    for (const m of source.matchAll(/from\s+'(\.\.?\/[^']+)'/g)) {
      const specifier = m[1] as string
      if (!specifier.startsWith('../')) continue // import dentro del mismo dominio
      edges.push({
        file: relative(SRC, file),
        domain,
        target: specifier.split('/')[1] as string,
        specifier,
      })
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
    const bad = edges.filter((e) => e.specifier !== `../${e.target}/index.js`)
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
