import type { ErrorRequestHandler } from 'express'

/** Prefijos de `type` con que body-parser (paquete http-errors) marca sus errores. */
const BODY_PARSER_ERROR_TYPE = /^(?:charset|encoding|entity|parameters|request|stream)\./

function bodyParserFailure(error: unknown): Error | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const { status, statusCode, type } = error as {
    status?: unknown
    statusCode?: unknown
    type?: unknown
  }
  const code = typeof status === 'number' ? status : statusCode
  if (typeof code !== 'number' || typeof type !== 'string' || !BODY_PARSER_ERROR_TYPE.test(type)) {
    return undefined
  }
  return Object.assign(new Error(`body-parser: ${type}`), {
    status: code,
    statusCode: code,
    expose: code < 500,
    type,
  })
}

/**
 * Manejador de errores de Express que va justo después de los parsers del cuerpo. Nest convierte
 * todo `SyntaxError` que llega a su capa de errores en un `BadRequestException` con el mensaje del
 * parser, y así se pierde que el problema fue un JSON ilegible. Aquí el error de body-parser se
 * reemplaza por uno plano con solo `status` y `type` (nunca el mensaje ni el cuerpo, que traen lo que
 * mandó el cliente), y `AllExceptionsFilter` lo traduce a `MALFORMED_JSON`, `PAYLOAD_TOO_LARGE` o
 * `BAD_REQUEST`. Cualquier otro error sigue igual.
 */
export const bodyParserErrorMiddleware: ErrorRequestHandler = (
  error,
  _request,
  _response,
  next,
) => {
  next(bodyParserFailure(error) ?? error)
}
