import type { ApiErrorCode } from '@anticipate/shared/api'
import type { ApplicationError } from '#/common/exceptions/index.js'

/**
 * Reconoce un error de una librería de infraestructura (Prisma, `pg`) y devuelve el
 * `ApplicationError` que le corresponde, o `undefined` si no lo reconoce. Así `common` no sabe nada
 * de esas librerías: cada adaptador de `infrastructure` publica su traductor y la raíz de
 * composición (`app.module.ts`) los entrega a `AllExceptionsFilter` con `EXCEPTION_TRANSLATORS`.
 *
 * Un traductor es una función pura y barata: la llama el filtro con cada error que no es ya un
 * `ApplicationError` ni una `HttpException`. Si no está seguro, devuelve `undefined` y el error
 * sigue siendo un 500 (un defecto del código).
 */
export type ExceptionTranslator = (
  exception: unknown,
) => ApplicationError<ApiErrorCode, object> | undefined

/** Token de la lista de traductores de `AllExceptionsFilter`, en orden: gana el primero que reconoce. */
export const EXCEPTION_TRANSLATORS = Symbol('EXCEPTION_TRANSLATORS')
