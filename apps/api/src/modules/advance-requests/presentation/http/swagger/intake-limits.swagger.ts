import {
  apiSuccessEnvelopeSchema,
  DEFAULT_SUCCESS_MESSAGE,
  intakeLimitsSchema,
} from '@anticipate/shared/api'
import { applyDecorators } from '@nestjs/common'
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger'
import { CORRELATION_ID_RESPONSE_HEADER } from '#/common/swagger/api-enveloped-response.swagger.js'
import {
  ApiErrorResponses,
  COMMON_API_ERROR_CODES,
} from '#/common/swagger/api-error-responses.swagger.js'
import { INTAKE_LIMITS_CACHE_CONTROL } from '../constants/intake-limits.constants.js'

/**
 * Documentación de `GET /api/v1/intake-limits`. Como la de `GET /api/v1/payers`, el 200 se declara con
 * `ApiOkResponse` para documentar también `Cache-Control`; el esquema es el `intakeLimitsSchema` de
 * `shared` dentro del sobre.
 */
export function ApiIntakeLimitsDocs() {
  return applyDecorators(
    ApiOperation({
      summary: 'Topes de un envío de solicitud',
      description:
        'Lo que la landing revisa antes de enviar `POST /api/v1/advance-requests`: archivos por ' +
        'solicitud (XML y PDF juntos), bytes de cada XML y de cada PDF, y bytes del cuerpo entero ' +
        '(con el formulario y lo que suma el multipart: `submissionBodyBytesUpperBound` de ' +
        '`@anticipate/shared/api`). El máximo de facturas es de cada pagador (`GET /api/v1/payers`).',
    }),
    ApiOkResponse({
      description: `Topes de la configuración de la API. Mensaje: «${DEFAULT_SUCCESS_MESSAGE}».`,
      standardSchema: apiSuccessEnvelopeSchema(intakeLimitsSchema),
      headers: {
        ...CORRELATION_ID_RESPONSE_HEADER,
        'Cache-Control': {
          description: 'La landing y la CDN pueden reutilizar los topes durante cinco minutos.',
          schema: { type: 'string', example: INTAKE_LIMITS_CACHE_CONTROL },
        },
      },
    }),
    ApiErrorResponses(...COMMON_API_ERROR_CODES),
  )
}
