import type { AdvanceRequestForm } from '@anticipate/shared/advance-request'
import type { UploadedFile } from '#/modules/advance-requests/domain/types/invoice-intake.types.js'

/** Lo que llega del controlador: formulario validado, archivos de multer y datos de la petición. */
export type CreateAdvanceRequestInput = {
  form: AdvanceRequestForm
  xmlFiles: readonly UploadedFile[]
  pdfFiles: readonly UploadedFile[]
  /** `Idempotency-Key` ya validada como UUID, en minúsculas. */
  idempotencyKey: string
  clientIp: string
  userAgent: string | null
  correlationId: string | null
}

export type CreateAdvanceRequestOutput = {
  publicCode: string
  /** `true` si la respuesta repite un envío ya guardado con la misma clave y la misma huella. */
  replayed: boolean
}

/** Genera las claves primarias que la API asigna antes de insertar (UUIDv7, `newId()`). */
export type IdGenerator = () => string
