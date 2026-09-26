import { z } from 'zod'
import { integer } from './env-values.js'

/**
 * Topes del envío de solicitudes. `UPLOAD_MAX_BODY_BYTES` se revisa por `Content-Length` antes de
 * leer el cuerpo (413); los topes por archivo los revisa la admisión, para responder 422 con el
 * nombre del archivo. `UPLOAD_MAX_INFLIGHT_BYTES` es la suma de los `Content-Length` que el proceso
 * lee en memoria a la vez: un envío que no cabe recibe 503 con `Retry-After` antes de leerse.
 */
export const uploadShape = {
  UPLOAD_MAX_BODY_BYTES: integer({ fallback: 95_000_000, min: 1, max: 500_000_000 }),
  UPLOAD_MAX_INFLIGHT_BYTES: integer({ fallback: 190_000_000, min: 1, max: 4_000_000_000 }),
  UPLOAD_MAX_PDF_BYTES: integer({ fallback: 10 * 1024 * 1024, min: 1, max: 100 * 1024 * 1024 }),
  UPLOAD_MAX_XML_BYTES: integer({ fallback: 1024 * 1024, min: 1, max: 10 * 1024 * 1024 }),
  UPLOAD_MAX_FILES: integer({ fallback: 20, min: 1, max: 200 }),
}

const uploadSchema = z.object(uploadShape)
export type UploadEnvironment = z.output<typeof uploadSchema>

export function refineUpload(env: UploadEnvironment, ctx: z.RefinementCtx): void {
  if (env.UPLOAD_MAX_INFLIGHT_BYTES < env.UPLOAD_MAX_BODY_BYTES) {
    ctx.addIssue({
      code: 'custom',
      path: ['UPLOAD_MAX_INFLIGHT_BYTES'],
      message:
        'debe ser al menos UPLOAD_MAX_BODY_BYTES: si no, un envío del tamaño máximo nunca entraría',
    })
  }
}

export function toUploadConfig(env: UploadEnvironment) {
  return {
    upload: {
      maxBodyBytes: env.UPLOAD_MAX_BODY_BYTES,
      maxInflightBytes: env.UPLOAD_MAX_INFLIGHT_BYTES,
      maxPdfBytes: env.UPLOAD_MAX_PDF_BYTES,
      maxXmlBytes: env.UPLOAD_MAX_XML_BYTES,
      maxFiles: env.UPLOAD_MAX_FILES,
    },
  }
}
