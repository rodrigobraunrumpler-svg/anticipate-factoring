import type { ProblemCode } from './codes.js'
import { MESSAGES_ES } from './messages.es.js'

export type Problem = {
  code: ProblemCode
  message: string
  /** Serie-número de la factura a la que se refiere, si aplica. */
  invoice?: string
  /** Campo del formulario al que se refiere, si aplica. */
  field?: string
  /** Identificador de la regla que lo produjo, si aplica (para métricas). */
  rule?: string
}

export type ProblemExtra = {
  invoice?: string
  field?: string
  rule?: string
  data?: Record<string, string | number>
}

function interpolate(template: string, data: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, key: string) => {
    const value = data[key]
    return value === undefined ? placeholder : String(value)
  })
}

export function createProblem(code: ProblemCode, extra: ProblemExtra = {}): Problem {
  const problem: Problem = { code, message: interpolate(MESSAGES_ES[code], extra.data) }
  if (extra.invoice !== undefined) problem.invoice = extra.invoice
  if (extra.field !== undefined) problem.field = extra.field
  if (extra.rule !== undefined) problem.rule = extra.rule
  return problem
}
