import { ServiceUnavailableError } from '#/common/exceptions/index.js'
import type { ExceptionTranslator } from '#/common/filters/index.js'
import { isDatabaseUnavailableError } from './prisma-errors.js'

/**
 * Traductor de `AllExceptionsFilter` para la base: un error que dice que la base no está disponible
 * (`isDatabaseUnavailableError`) es 503 `SERVICE_UNAVAILABLE`, venga de la ruta que venga y aunque
 * el caso de uso no lo haya envuelto. Cualquier otro error de la base no se toca: una consulta mal
 * escrita o una restricción violada sin su regla gemela es un defecto del código (500).
 */
export const translateDatabaseException: ExceptionTranslator = (exception) =>
  isDatabaseUnavailableError(exception)
    ? new ServiceUnavailableError('la base de datos no está disponible', { cause: exception })
    : undefined
