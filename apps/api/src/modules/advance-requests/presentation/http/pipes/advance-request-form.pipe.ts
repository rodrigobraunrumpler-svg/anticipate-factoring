import {
  type AdvanceRequestForm,
  advanceRequestFormSchema,
  FORM_MESSAGES,
} from '@anticipate/shared/advance-request'
import { Injectable, type PipeTransform } from '@nestjs/common'
import { ApiValidationError } from '#/common/exceptions/index.js'
import { ADVANCE_REQUEST_FORM_FIELD } from '#/modules/advance-requests/presentation/http/constants/multipart.constants.js'

const notAForm = () =>
  new ApiValidationError(
    [{ field: ADVANCE_REQUEST_FORM_FIELD, messages: [FORM_MESSAGES.form] }],
    'el campo form falta o no es JSON',
  )

/**
 * El formulario viaja como texto JSON en la parte `form` del multipart y se valida con el esquema
 * de shared. Sin la parte o con un JSON inválido: 400 `VALIDATION_ERROR` en `form`. Con datos
 * inválidos: una violación por campo, con la ruta dentro del formulario (`contact.mobile`).
 */
@Injectable()
export class AdvanceRequestFormPipe implements PipeTransform<unknown, AdvanceRequestForm> {
  transform(value: unknown): AdvanceRequestForm {
    if (typeof value !== 'string') throw notAForm()
    let raw: unknown
    try {
      raw = JSON.parse(value)
    } catch {
      throw notAForm()
    }
    const result = advanceRequestFormSchema.safeParse(raw)
    if (result.success) return result.data
    throw new ApiValidationError(
      result.error.issues.map((issue) => ({
        field:
          issue.path.length === 0 ? ADVANCE_REQUEST_FORM_FIELD : issue.path.map(String).join('.'),
        messages: [issue.message],
      })),
      'el formulario no cumple advanceRequestFormSchema',
    )
  }
}
