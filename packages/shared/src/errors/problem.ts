import type { ProblemCode } from './codes.js'
import { MESSAGES_ES } from './messages.es.js'

export type Problem = {
  code: ProblemCode
  message: string
  /** Serie-número de la factura a la que se refiere, si aplica. */
  invoice?: string
  /** Campo al que se refiere (del formulario o de la factura leída), si aplica. */
  field?: string
  /** Identificador de la regla que lo produjo, si aplica (para métricas). */
  rule?: string
  /**
   * Datos con los que se armó `message`. Solo está si hubo datos: permite que un consumidor vuelva a
   * renderizar el mensaje o lo traduzca a partir de `code` sin analizar el texto en español.
   */
  params?: Record<string, string | number>
}

export type ProblemExtra = {
  invoice?: string
  field?: string
  rule?: string
  data?: Record<string, string | number>
}

/**
 * Reemplaza los marcadores `{nombre}` de `template` con los valores de `data`. Un marcador sin valor
 * queda tal cual, para que un dato faltante se note en el texto en vez de desaparecer.
 */
export function formatMessage(
  template: string,
  data: Readonly<Record<string, string | number>> = {},
): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, key: string) => {
    const value = Object.hasOwn(data, key) ? data[key] : undefined
    return value === undefined ? placeholder : String(value)
  })
}

export function createProblem(code: ProblemCode, extra: ProblemExtra = {}): Problem {
  const problem: Problem = { code, message: formatMessage(MESSAGES_ES[code], extra.data) }
  if (extra.invoice !== undefined) problem.invoice = extra.invoice
  if (extra.field !== undefined) problem.field = extra.field
  if (extra.rule !== undefined) problem.rule = extra.rule
  if (extra.data !== undefined && Object.keys(extra.data).length > 0) {
    problem.params = { ...extra.data }
  }
  return problem
}
