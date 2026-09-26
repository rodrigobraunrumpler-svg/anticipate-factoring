import { z } from 'zod'
import { isFileName } from '../text/index.js'
import { PROBLEM_CODES, type ProblemCode } from './codes.js'
import { MESSAGES_ES } from './messages.es.js'

export type Problem = {
  code: ProblemCode
  message: string
  /** Serie-número de la factura a la que se refiere, si aplica. */
  invoice?: string
  /** Campo al que se refiere (del formulario o de la factura leída), si aplica. */
  field?: string
  /**
   * Nombre del archivo subido (XML o PDF) al que se refiere, si aplica, tal como llegó. Con él la
   * landing marca la fila del archivo exacto, también cuando el XML no se pudo leer y no hay
   * serie-número. Siempre es un nombre de archivo (`isFileName` de `text`): un archivo cuyo nombre no
   * lo es recibe `INVALID_FILE_NAME`, que lo muestra acortado en `params` y no lleva `file`.
   */
  file?: string
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
  file?: string
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
  if (extra.file !== undefined) problem.file = extra.file
  if (extra.rule !== undefined) problem.rule = extra.rule
  if (extra.data !== undefined && Object.keys(extra.data).length > 0) {
    problem.params = { ...extra.data }
  }
  return problem
}

/**
 * Forma exacta de un `Problem` que viaja en una respuesta (`details.problems` del sobre de error de
 * la API). Estricta: una propiedad que `createProblem` no produce es un error del contrato. Valida
 * respuestas propias (tests de contrato y clientes de la API), no entrada de personas: sus issues
 * nunca se muestran al usuario, por eso usan los mensajes por defecto de Zod. `file` es el nombre tal
 * como llegó en el envío y tiene que ser un nombre de archivo (`isFileName`): así ningún problema
 * repite un nombre sin tope o con controles. El resto lo produce el código y no es vacío.
 */
export const problemSchema = z.strictObject({
  code: z.enum(PROBLEM_CODES),
  message: z.string().min(1),
  invoice: z.string().min(1).exactOptional(),
  field: z.string().min(1).exactOptional(),
  file: z.string().refine(isFileName).exactOptional(),
  rule: z.string().min(1).exactOptional(),
  params: z.record(z.string(), z.union([z.string(), z.number()])).exactOptional(),
})
