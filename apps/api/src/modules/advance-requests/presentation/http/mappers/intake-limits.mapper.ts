import { type IntakeLimits, intakeLimitsSchema } from '@anticipate/shared/api'
import type { AppConfig } from '#/common/config/index.js'

/**
 * Los topes de subida de la configuración (`UPLOAD_MAX_*`) en el contrato de `shared`: solo los que la
 * landing revisa antes de enviar. `UPLOAD_MAX_INFLIGHT_BYTES` es de la operación del servidor y no
 * sale. Lo valida `intakeLimitsSchema`: lo que sale es exactamente lo que la landing espera.
 */
export function toIntakeLimits(upload: AppConfig['upload']): IntakeLimits {
  return intakeLimitsSchema.parse({
    maxFiles: upload.maxFiles,
    maxXmlBytes: upload.maxXmlBytes,
    maxPdfBytes: upload.maxPdfBytes,
    maxBodyBytes: upload.maxBodyBytes,
  })
}
