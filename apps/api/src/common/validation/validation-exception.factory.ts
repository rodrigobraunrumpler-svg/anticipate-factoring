import { ApiValidationError } from '#/common/exceptions/index.js'

/** Lo que usa de un issue de Standard Schema (el tipo de `@standard-schema/spec` encaja aquí). */
export type SchemaIssue = {
  readonly message: string
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined
}

/** Ruta de un issue con puntos (`contact.email`, `invoices.0.total`); vacía para el valor completo. */
export function issueField(issue: SchemaIssue): string {
  return (issue.path ?? [])
    .map((segment) => (typeof segment === 'object' && segment !== null ? segment.key : segment))
    .map((key) => (typeof key === 'symbol' ? (key.description ?? '') : String(key)))
    .join('.')
}

/**
 * `exceptionFactory` del `StandardSchemaValidationPipe` global: agrupa los issues por ruta en un
 * `ApiValidationError` (400 `VALIDATION_ERROR` con `details.violations`). Los mensajes son los del
 * esquema: los de `shared` están en español y los mensajes por defecto de Zod también, porque
 * `setupApp` activa `z.locales.es()`.
 */
export function validationExceptionFactory(issues: readonly SchemaIssue[]): ApiValidationError {
  return new ApiValidationError(
    issues.map((issue) => ({ field: issueField(issue), messages: [issue.message] })),
  )
}
