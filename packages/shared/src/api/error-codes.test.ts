import { describe, expect, it } from 'vitest'
import { API_MESSAGES_ES } from '../errors/index.js'
import {
  API_ERROR_CODES,
  API_ERROR_HTTP_STATUS,
  API_ERROR_HTTP_STATUSES,
  API_ERROR_MESSAGES_ES,
  isApiErrorCode,
} from './error-codes.js'
import { DEFAULT_SUCCESS_MESSAGE, SUCCESS_MESSAGES_ES } from './success-messages.js'

describe('códigos de error de la API', () => {
  it('todo código tiene mensaje y estado, y ninguna tabla tiene claves de más', () => {
    const codes = [...API_ERROR_CODES].sort()
    expect(Object.keys(API_ERROR_MESSAGES_ES).sort()).toEqual(codes)
    expect(Object.keys(API_ERROR_HTTP_STATUS).sort()).toEqual(codes)
    for (const code of API_ERROR_CODES) {
      expect(API_ERROR_MESSAGES_ES[code], code).toBeTypeOf('string')
      expect(API_ERROR_HTTP_STATUSES, code).toContain(API_ERROR_HTTP_STATUS[code])
    }
  })

  it('los códigos no se repiten y todo estado declarado lo usa algún código', () => {
    expect(new Set(API_ERROR_CODES).size).toBe(API_ERROR_CODES.length)
    const used = new Set(Object.values(API_ERROR_HTTP_STATUS))
    expect([...API_ERROR_HTTP_STATUSES].filter((status) => !used.has(status))).toEqual([])
  })

  it('cada código tiene el estado y el mensaje del contrato', () => {
    const contract = {
      BAD_REQUEST: [400, 'La solicitud no tiene el formato esperado.'],
      VALIDATION_ERROR: [400, 'Revisa los datos enviados.'],
      MALFORMED_JSON: [400, 'El cuerpo de la solicitud no es un JSON válido.'],
      MALFORMED_MULTIPART: [400, 'El envío de archivos no tiene el formato esperado.'],
      TOO_MANY_FILES: [400, 'Adjuntaste más archivos de los permitidos.'],
      UNEXPECTED_FILE_FIELD: [
        400,
        'El envío trae archivos en un campo no permitido. Usa los campos xml y pdf.',
      ],
      IDEMPOTENCY_KEY_INVALID: [400, 'Falta la cabecera Idempotency-Key o no es un UUID válido.'],
      CAPTCHA_FAILED: [
        403,
        'No pudimos verificar que eres una persona. Recarga la página e inténtalo de nuevo.',
      ],
      RESOURCE_NOT_FOUND: [404, 'La ruta solicitada no existe.'],
      CONFLICT: [409, 'La información cambió mientras la editabas. Recarga e inténtalo de nuevo.'],
      LENGTH_REQUIRED: [411, 'El envío debe indicar su tamaño (Content-Length).'],
      PAYLOAD_TOO_LARGE: [413, 'El envío supera el tamaño máximo permitido.'],
      BUSINESS_RULES_VIOLATED: [
        422,
        'La solicitud no cumple las condiciones del programa. Revisa el detalle.',
      ],
      IDEMPOTENCY_KEY_REUSED: [
        422,
        'Esta clave de envío ya se usó con otros datos. Recarga la página e inténtalo de nuevo.',
      ],
      RATE_LIMIT_EXCEEDED: [
        429,
        'Hiciste demasiados envíos seguidos. Inténtalo de nuevo más tarde.',
      ],
      INTERNAL_ERROR: [500, 'Ocurrió un error inesperado. Inténtalo de nuevo.'],
      SERVICE_UNAVAILABLE: [
        503,
        'No pudimos procesar tu solicitud en este momento. Inténtalo de nuevo en unos minutos.',
      ],
      CAPTCHA_UNAVAILABLE: [
        503,
        'No pudimos verificar el captcha en este momento. Inténtalo de nuevo en unos minutos.',
      ],
    } as const
    expect(Object.keys(contract)).toEqual([...API_ERROR_CODES])
    for (const code of API_ERROR_CODES) {
      expect([API_ERROR_HTTP_STATUS[code], API_ERROR_MESSAGES_ES[code]], code).toEqual(
        contract[code],
      )
    }
  })

  it('los mensajes son los de errors, sin marcadores', () => {
    expect(API_ERROR_MESSAGES_ES).toBe(API_MESSAGES_ES.errors)
    for (const message of Object.values(API_ERROR_MESSAGES_ES)) expect(message).not.toMatch(/[{}]/)
  })

  it('isApiErrorCode acepta solo códigos del contrato, sin propiedades heredadas', () => {
    expect(isApiErrorCode('CAPTCHA_FAILED')).toBe(true)
    for (const value of ['captcha_failed', 'NOPE', '', 'constructor', 'toString']) {
      expect(isApiErrorCode(value), value).toBe(false)
    }
  })
})

describe('mensajes de éxito', () => {
  it('son los del contrato', () => {
    expect(DEFAULT_SUCCESS_MESSAGE).toBe('Operación realizada.')
    expect(SUCCESS_MESSAGES_ES).toEqual({ advanceRequestCreated: 'Solicitud recibida.' })
  })

  it('las tablas son de solo lectura en tiempo de compilación', () => {
    // Nunca se ejecuta: solo comprueba con `tsc` que asignar a las tablas no compila.
    const mutate = () => {
      // @ts-expect-error la tabla es de solo lectura
      API_ERROR_MESSAGES_ES.CONFLICT = 'x'
      // @ts-expect-error la tabla es de solo lectura
      API_ERROR_HTTP_STATUS.CONFLICT = 400
      // @ts-expect-error la tabla es de solo lectura
      SUCCESS_MESSAGES_ES.advanceRequestCreated = 'x'
    }
    expect(mutate).toBeTypeOf('function')
  })
})
