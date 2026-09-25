import { z } from 'zod'
import { type Problem, problemSchema } from '../errors/index.js'
import { API_ERROR_CODES, API_ERROR_HTTP_STATUS, type ApiErrorCode } from './error-codes.js'

/**
 * Sobres de respuesta de la API: todo éxito y todo error
 * (salvo `/health*`, que responde con el cuerpo de Terminus) tienen la misma forma, así la landing y
 * el admin leen siempre lo mismo.
 *
 * Los esquemas validan respuestas propias (tests de contrato de la API y clientes), no entrada de
 * personas: sus issues nunca se muestran al usuario, por eso usan los mensajes por defecto de Zod.
 * Son estrictos: una propiedad de más (una traza, el `error` de Nest) es un error del contrato. Si el
 * contrato crece, cambia aquí primero y la API y sus clientes lo toman del mismo `shared`.
 */

/** Resumen de una página de un catálogo acotado (pagadores, usuarios). */
export type PaginationMeta = {
  totalCount: number
  pageCount: number
  currentPage: number
  isFirstPage: boolean
  isLastPage: boolean
  previousPage: number | null
  nextPage: number | null
}

/** Cursor de una lista sin tope del admin, ordenada por `id DESC` (UUIDv7). */
export type CursorMeta = { nextCursor: string | null; hasNext: boolean }

export type ApiSuccessEnvelope<T> = {
  success: true
  statusCode: number
  message: string
  data: T
  metadataPagination?: PaginationMeta
  metadataCursor?: CursorMeta
  correlationId: string
  timestamp: string
}

/** Un campo del cuerpo y sus mensajes. `field` es la ruta con puntos (`contact.email`); vacía en la raíz. */
export type ValidationViolation = { field: string; messages: string[] }

export type ApiErrorEnvelope = {
  success: false
  statusCode: number
  code: ApiErrorCode
  message: string
  details?: { violations: ValidationViolation[] } | { problems: Problem[] }
  correlationId: string
  timestamp: string
}

/**
 * Correlation id aceptado de afuera (`x-correlation-id`) y devuelto en todo sobre. Letras, dígitos,
 * `.`, `_` y `-`, de 1 a 128 caracteres: cabe en `correlation_id VARCHAR(128)` y no inyecta nada en
 * los logs. La API genera un UUID cuando la cabecera falta o no cumple.
 */
export const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

const correlationIdSchema = z.string().regex(CORRELATION_ID_PATTERN)
/** Instante en ISO 8601 UTC, como `Date.prototype.toISOString()`. */
const timestampSchema = z.iso.datetime()

export const paginationMetaSchema = z.strictObject({
  totalCount: z.int().min(0),
  pageCount: z.int().min(0),
  currentPage: z.int().min(1),
  isFirstPage: z.boolean(),
  isLastPage: z.boolean(),
  previousPage: z.int().min(1).nullable(),
  nextPage: z.int().min(1).nullable(),
})

export const cursorMetaSchema = z
  .strictObject({ nextCursor: z.string().min(1).nullable(), hasNext: z.boolean() })
  .refine((meta) => meta.hasNext === (meta.nextCursor !== null), {
    error: 'hasNext debe ser true si y solo si hay nextCursor.',
    path: ['hasNext'],
  })

export const validationViolationSchema = z.strictObject({
  field: z.string(),
  messages: z.array(z.string().min(1)).min(1),
})

/**
 * Sobre de éxito con `data` validado por `dataSchema`. Una lista paginada lleva
 * `metadataPagination` o `metadataCursor`, nunca los dos, y su `data` es un arreglo.
 */
export function apiSuccessEnvelopeSchema<TData>(dataSchema: z.ZodType<TData>) {
  return z
    .strictObject({
      success: z.literal(true),
      statusCode: z.int().min(200).max(299),
      message: z.string().min(1),
      data: dataSchema,
      metadataPagination: paginationMetaSchema.exactOptional(),
      metadataCursor: cursorMetaSchema.exactOptional(),
      correlationId: correlationIdSchema,
      timestamp: timestampSchema,
    })
    .superRefine((envelope, ctx) => {
      const paginated =
        envelope.metadataPagination !== undefined || envelope.metadataCursor !== undefined
      if (envelope.metadataPagination !== undefined && envelope.metadataCursor !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['metadataCursor'],
          message: 'Un sobre lleva metadataPagination o metadataCursor, no los dos.',
        })
      }
      if (paginated && !Array.isArray(envelope.data)) {
        ctx.addIssue({
          code: 'custom',
          path: ['data'],
          message: 'Una respuesta paginada lleva un arreglo en data.',
        })
      }
    })
}

/**
 * Estado HTTP que admite un sobre con `code`. `BAD_REQUEST` e `INTERNAL_ERROR` son la reserva para
 * excepciones HTTP sin código propio (otro 4xx y otro 5xx): admiten cualquier estado de su clase. Los
 * demás códigos responden exactamente con `API_ERROR_HTTP_STATUS[code]`.
 */
function statusMatchesCode(code: ApiErrorCode, statusCode: number): boolean {
  if (code === 'BAD_REQUEST') return statusCode >= 400 && statusCode <= 499
  if (code === 'INTERNAL_ERROR') return statusCode >= 500 && statusCode <= 599
  return statusCode === API_ERROR_HTTP_STATUS[code]
}

const errorEnvelopeFields = {
  success: z.literal(false),
  statusCode: z.int(),
  message: z.string().min(1),
  correlationId: correlationIdSchema,
  timestamp: timestampSchema,
}

/**
 * Sobre de error. `VALIDATION_ERROR` lleva `details.violations`, `BUSINESS_RULES_VIOLATED` lleva
 * `details.problems` (ambas listas con al menos un elemento) y los demás códigos no llevan
 * `details`. `statusCode` es el del código (ver `statusMatchesCode`).
 */
export const apiErrorEnvelopeSchema = z
  .discriminatedUnion('code', [
    z.strictObject({
      ...errorEnvelopeFields,
      code: z.literal('VALIDATION_ERROR'),
      details: z.strictObject({ violations: z.array(validationViolationSchema).min(1) }),
    }),
    z.strictObject({
      ...errorEnvelopeFields,
      code: z.literal('BUSINESS_RULES_VIOLATED'),
      details: z.strictObject({ problems: z.array(problemSchema).min(1) }),
    }),
    z.strictObject({
      ...errorEnvelopeFields,
      code: z.enum(API_ERROR_CODES).exclude(['VALIDATION_ERROR', 'BUSINESS_RULES_VIOLATED']),
    }),
  ])
  .superRefine((envelope, ctx) => {
    if (!statusMatchesCode(envelope.code, envelope.statusCode)) {
      ctx.addIssue({
        code: 'custom',
        path: ['statusCode'],
        message: `El código ${envelope.code} no responde con ${envelope.statusCode}.`,
      })
    }
  })
