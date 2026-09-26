import { z } from 'zod'
import { API_MESSAGES_ES, formatMessage } from '../errors/index.js'

/**
 * Bytes que el multipart suma a cada parte, además de su contenido: el separador (hasta 74 bytes con
 * el máximo de 70 caracteres de RFC 2046), la cabecera `Content-Disposition` con el nombre del campo
 * y un nombre de archivo de hasta 255 unidades UTF-16 (a lo sumo 765 bytes: 3 por unidad, en UTF-8 o
 * como `%22`), `Content-Type` y los saltos de línea. Es una cota por arriba, no un promedio.
 */
export const MULTIPART_PART_OVERHEAD_BYTES = 1024

/**
 * Bytes del campo `form` de `POST /api/v1/advance-requests` (el JSON del formulario). El formulario
 * más largo posible, con escapes, ocupa menos de 32 KiB. La API lo usa como tope de multer.
 */
export const MAX_FORM_FIELD_BYTES = 64 * 1024

/**
 * Topes de un envío a `POST /api/v1/advance-requests`, tal como los publica
 * `GET /api/v1/intake-limits`. Con ellos la landing avisa antes de enviar, en vez de recibir el
 * rechazo de la API:
 * - `maxFiles`: archivos por solicitud, XML y PDF juntos (si pasa, 400 `TOO_MANY_FILES`);
 * - `maxXmlBytes` y `maxPdfBytes`: bytes de cada XML y de cada PDF (422 `XML_TOO_LARGE` o
 *   `FILE_TOO_LARGE` con el nombre del archivo);
 * - `maxBodyBytes`: bytes del cuerpo entero, con el formulario y lo que suma el multipart (413
 *   `PAYLOAD_TOO_LARGE`); se compara con `submissionBodyBytesUpperBound`.
 *
 * El máximo de facturas es de cada pagador (`maxInvoices` de `GET /api/v1/payers`). Valida una
 * respuesta propia de la API, no entrada de personas: usa los mensajes por defecto de Zod.
 */
export const intakeLimitsSchema = z.strictObject({
  maxFiles: z.int().min(1),
  maxXmlBytes: z.int().min(1),
  maxPdfBytes: z.int().min(1),
  maxBodyBytes: z.int().min(1),
})
export type IntakeLimits = z.infer<typeof intakeLimitsSchema>

function assertCount(name: string, value: number, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(`${name} debe ser un entero de al menos ${min}; llegó ${value}`)
  }
}

/**
 * Cota por arriba del cuerpo de un envío con archivos de estos tamaños: sus bytes, lo que el multipart
 * suma a cada parte (`MULTIPART_PART_OVERHEAD_BYTES`), el campo `form` más largo posible con su parte
 * y el cierre. Si no pasa de `maxBodyBytes`, la API recibe el envío entero; la landing la calcula con
 * los archivos elegidos antes de enviar.
 */
export function submissionBodyBytesUpperBound(fileSizes: readonly number[]): number {
  let total = MAX_FORM_FIELD_BYTES + 2 * MULTIPART_PART_OVERHEAD_BYTES
  for (const size of fileSizes) {
    assertCount('El tamaño de un archivo', size, 0)
    total += size + MULTIPART_PART_OVERHEAD_BYTES
  }
  return total
}

/** Tope de `IntakeLimits` que no alcanza para la solicitud más grande de un pagador. */
export type IntakeCapacityShortfall = {
  readonly limit: 'maxFiles' | 'maxBodyBytes'
  readonly current: number
  readonly required: number
}

/**
 * Lo que les falta a los topes para recibir la solicitud más grande que admite un pagador:
 * `maxInvoices` facturas, cada una con su XML del tamaño máximo y su PDF. Cada PDF cuenta como archivo
 * y como parte del multipart, pero no por su peso: con los topes por defecto, diez PDF de 10 MiB no
 * caben en 95 MB (y Cloudflare corta el cuerpo en 100 MB), así que el peso de los PDF lo revisa la
 * landing con `maxBodyBytes` antes de enviar. Lista vacía: los topes alcanzan. La API la revisa con
 * cada pagador activo (al arrancar y al servir `GET /api/v1/payers`) y el admin puede hacerlo al
 * cambiar `maxInvoices`.
 */
export function intakeCapacityShortfalls(
  maxInvoices: number,
  limits: IntakeLimits,
): IntakeCapacityShortfall[] {
  assertCount('El máximo de facturas', maxInvoices, 1)
  const shortfalls: IntakeCapacityShortfall[] = []
  const requiredFiles = 2 * maxInvoices
  if (limits.maxFiles < requiredFiles) {
    shortfalls.push({ limit: 'maxFiles', current: limits.maxFiles, required: requiredFiles })
  }
  const requiredBody = submissionBodyBytesUpperBound([
    ...Array<number>(maxInvoices).fill(limits.maxXmlBytes),
    ...Array<number>(maxInvoices).fill(0),
  ])
  if (limits.maxBodyBytes < requiredBody) {
    shortfalls.push({ limit: 'maxBodyBytes', current: limits.maxBodyBytes, required: requiredBody })
  }
  return shortfalls
}

/** `message` de 400 `TOO_MANY_FILES`: cuántos archivos admite la solicitud y qué hacer. */
export function tooManyFilesMessage(maxFiles: number): string {
  assertCount('El tope de archivos', maxFiles, 1)
  return formatMessage(API_MESSAGES_ES.limits.TOO_MANY_FILES, { max: maxFiles })
}
