import { z } from 'zod'
import { integer } from './env-values.js'

/**
 * Topes del envío de solicitudes. `UPLOAD_MAX_BODY_BYTES` se revisa por `Content-Length` antes de
 * leer el cuerpo (413); los topes por archivo los revisa la admisión, para responder 422 con el
 * nombre del archivo.
 */
export const uploadShape = {
  UPLOAD_MAX_BODY_BYTES: integer({ fallback: 95_000_000, min: 1, max: 500_000_000 }),
  UPLOAD_MAX_PDF_BYTES: integer({ fallback: 10 * 1024 * 1024, min: 1, max: 100 * 1024 * 1024 }),
  UPLOAD_MAX_XML_BYTES: integer({ fallback: 1024 * 1024, min: 1, max: 10 * 1024 * 1024 }),
  UPLOAD_MAX_FILES: integer({ fallback: 20, min: 1, max: 200 }),
}

const uploadSchema = z.object(uploadShape)
export type UploadEnvironment = z.output<typeof uploadSchema>

export function toUploadConfig(env: UploadEnvironment) {
  return {
    upload: {
      maxBodyBytes: env.UPLOAD_MAX_BODY_BYTES,
      maxPdfBytes: env.UPLOAD_MAX_PDF_BYTES,
      maxXmlBytes: env.UPLOAD_MAX_XML_BYTES,
      maxFiles: env.UPLOAD_MAX_FILES,
    },
  }
}
