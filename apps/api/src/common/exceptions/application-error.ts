import { API_ERROR_CODES, API_ERROR_MESSAGES_ES, type ApiErrorCode } from '@anticipate/shared/api'
import {
  type ApplicationErrorCategory,
  applicationErrorCategoryOf,
} from './application-error-category.js'

const CONSTRUCTED_APPLICATION_ERRORS = new WeakSet<object>()
const API_ERROR_CODE_SET: ReadonlySet<string> = new Set(API_ERROR_CODES)
const PUBLIC_OBJECT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,127}$/
const MAX_PUBLIC_DETAILS_DEPTH = 10

export type ApplicationErrorOptions<TDetails extends object> = {
  /** Datos públicos del error. Se copian en profundidad y se congelan. */
  readonly details?: TDetails | undefined
  /** Mensaje público. Por defecto, el de `API_ERROR_MESSAGES_ES` para el código. */
  readonly publicMessage?: string | undefined
  /** Diagnóstico privado para los logs: queda en `message` y nunca sale en la respuesta. */
  readonly diagnostic?: string | undefined
  /** Error original, para los logs. */
  readonly cause?: unknown
}

/**
 * Copia un valor como lo serializaría `JSON.stringify`: una propiedad `undefined` se omite, un
 * elemento `undefined` de un arreglo pasa a `null` y un número no finito pasa a `null`. Así un
 * opcional sin valor nunca convierte un 4xx en un 500. Lo que JSON no puede representar (funciones,
 * símbolos, `bigint`, instancias de clases, ciclos, accesores) es un error de programación y lanza
 * `TypeError`.
 */
function clonePublicValue(value: unknown, depth: number, ancestors: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'object') {
    throw new TypeError(
      `Los detalles públicos solo admiten datos JSON; llegó un valor ${typeof value}`,
    )
  }
  if (depth > MAX_PUBLIC_DETAILS_DEPTH || ancestors.has(value)) {
    throw new TypeError('Los detalles públicos deben ser JSON acotado y sin ciclos')
  }
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return Object.freeze(
        Array.from(value, (item: unknown) =>
          item === undefined ? null : clonePublicValue(item, depth + 1, ancestors),
        ),
      )
    }
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Los detalles públicos solo admiten objetos planos')
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError('Los detalles públicos no admiten claves símbolo')
    }
    const entries: [string, unknown][] = []
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!('value' in descriptor) || !PUBLIC_OBJECT_KEY.test(key)) {
        throw new TypeError(`Los detalles públicos tienen una propiedad inválida: ${key}`)
      }
      if (descriptor.value === undefined) continue
      entries.push([key, clonePublicValue(descriptor.value, depth + 1, ancestors)])
    }
    return Object.freeze(Object.fromEntries(entries))
  } finally {
    ancestors.delete(value)
  }
}

function clonePublicDetails<TDetails extends object>(details: TDetails): TDetails {
  if (Array.isArray(details)) {
    throw new TypeError('Los detalles públicos deben ser un objeto, no un arreglo')
  }
  return clonePublicValue(details, 0, new Set()) as TDetails
}

/**
 * Error de la aplicación con una proyección pública explícita: código, mensaje en español y detalle
 * opcional. El filtro HTTP solo publica eso; el diagnóstico y la causa quedan para los logs. No
 * importa nada de NestJS: lo usan también `domain` y `application`.
 */
export abstract class ApplicationError<
  TCode extends ApiErrorCode,
  TDetails extends object = never,
> extends Error {
  declare readonly category: ApplicationErrorCategory
  declare readonly publicCode: TCode
  declare readonly publicMessage: string
  declare readonly publicDetails?: TDetails

  protected constructor(code: TCode, options: ApplicationErrorOptions<TDetails> = {}) {
    if (typeof code !== 'string' || !API_ERROR_CODE_SET.has(code)) {
      throw new TypeError(`Código de error desconocido: ${String(code)}`)
    }
    const publicMessage = options.publicMessage ?? API_ERROR_MESSAGES_ES[code]
    if (typeof publicMessage !== 'string' || publicMessage.trim() === '') {
      throw new TypeError(`El error ${code} necesita un mensaje público no vacío`)
    }
    if (options.diagnostic !== undefined && typeof options.diagnostic !== 'string') {
      throw new TypeError(`El diagnóstico del error ${code} debe ser texto`)
    }
    const category = applicationErrorCategoryOf(code)
    const publicDetails =
      options.details === undefined ? undefined : clonePublicDetails(options.details)

    super(
      options.diagnostic ?? publicMessage,
      options.cause === undefined ? undefined : { cause: options.cause },
    )
    this.name = new.target.name
    Object.defineProperties(this, {
      category: { value: category, enumerable: true, writable: false, configurable: false },
      publicCode: { value: code, enumerable: true, writable: false, configurable: false },
      publicMessage: {
        value: publicMessage,
        enumerable: true,
        writable: false,
        configurable: false,
      },
      ...(publicDetails === undefined
        ? {}
        : {
            publicDetails: {
              value: publicDetails,
              enumerable: true,
              writable: false,
              configurable: false,
            },
          }),
    })
    CONSTRUCTED_APPLICATION_ERRORS.add(this)
  }
}

/** Verdadero solo para errores construidos por `ApplicationError` (no basta con parecerse). */
export function isApplicationError(
  value: unknown,
): value is ApplicationError<ApiErrorCode, object> {
  return value instanceof ApplicationError && CONSTRUCTED_APPLICATION_ERRORS.has(value)
}
