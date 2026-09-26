import type { AppConfig } from '#/common/config/index.js'
import type {
  MultipartFileField,
  MultipartLimits,
} from '#/common/interceptors/multipart-files.interceptor.js'

/** Parte de texto con el formulario en JSON. */
export const ADVANCE_REQUEST_FORM_FIELD = 'form'

/** Partes de archivos: XML de 1 a N y PDF de 0 a N, emparejados por nombre base. */
export const ADVANCE_REQUEST_FILE_FIELD = { xml: 'xml', pdf: 'pdf' } as const

/**
 * Tope fijo de archivos por campo, igual al máximo que admite `UPLOAD_MAX_FILES` en
 * `upload.schema.ts`. El decorador es estático; el límite real es `files`, que sale de la
 * configuración y corta antes (400 `TOO_MANY_FILES`). Si un campo superara su `maxCount`, multer
 * respondería `UNEXPECTED_FILE_FIELD`, que confundiría al proveedor.
 */
export const MAX_FILES_PER_FIELD = 200

/** Bytes del campo `form`: el formulario más largo posible, con escapes, ocupa menos de 32 KiB. */
export const MAX_FORM_FIELD_BYTES = 64 * 1024

export const ADVANCE_REQUEST_FILE_FIELDS: readonly MultipartFileField[] = [
  { name: ADVANCE_REQUEST_FILE_FIELD.xml, maxCount: MAX_FILES_PER_FIELD },
  { name: ADVANCE_REQUEST_FILE_FIELD.pdf, maxCount: MAX_FILES_PER_FIELD },
]

/**
 * Topes de multer para el envío. `fileSize` es solo un respaldo (el cuerpo entero ya pasó por
 * `Content-Length`): los topes por tipo los revisa la admisión, para responder 422 con el nombre
 * de cada archivo. Un solo campo de texto (`form`).
 */
export function advanceRequestMultipartLimits({ upload }: AppConfig): MultipartLimits {
  if (upload.maxFiles > MAX_FILES_PER_FIELD) {
    throw new RangeError(
      `UPLOAD_MAX_FILES (${upload.maxFiles}) supera el tope por campo (${MAX_FILES_PER_FIELD})`,
    )
  }
  return {
    files: upload.maxFiles,
    fileSize: upload.maxBodyBytes,
    parts: upload.maxFiles + 1,
    fields: 1,
    fieldSize: MAX_FORM_FIELD_BYTES,
  }
}
