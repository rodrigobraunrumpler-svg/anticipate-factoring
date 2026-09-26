import type { ADVANCE_REQUEST_FILE_FIELD } from '#/modules/advance-requests/presentation/http/constants/multipart.constants.js'

type FileField = (typeof ADVANCE_REQUEST_FILE_FIELD)[keyof typeof ADVANCE_REQUEST_FILE_FIELD]

/** Archivos que deja `MultipartFilesInterceptor` en `request.files` (un campo ausente no aparece). */
export type AdvanceRequestUploadedFiles = Partial<Record<FileField, Express.Multer.File[]>>
