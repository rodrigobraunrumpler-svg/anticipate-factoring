import { apiSuccessEnvelopeSchema, DEFAULT_SUCCESS_MESSAGE } from '@anticipate/shared/api'
import { publicPayerSchema } from '@anticipate/shared/payer'
import { applyDecorators } from '@nestjs/common'
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger'
import { CORRELATION_ID_RESPONSE_HEADER } from '#/common/swagger/api-enveloped-response.swagger.js'
import {
  ApiErrorResponses,
  COMMON_API_ERROR_CODES,
} from '#/common/swagger/api-error-responses.swagger.js'
import { PUBLIC_PAYERS_CACHE_CONTROL } from '../constants/public-payers.constants.js'

/**
 * Documentación de `GET /api/v1/payers`. El 200 se declara con `ApiOkResponse` y no con
 * `ApiEnvelopedResponse` porque además documenta `Cache-Control` (dos respuestas del mismo estado se
 * pisarían); el esquema es el mismo `apiSuccessEnvelopeSchema` de `shared`.
 */
export function ApiListPublicPayersDocs() {
  return applyDecorators(
    ApiOperation({
      summary: 'Pagadores activos del programa de adelanto',
      description:
        'Lo que la landing necesita para construir la página de cada pagador, solo con campos ' +
        'públicos. Un pagador cuya fila no cumple el contrato se omite y se registra, sin afectar a ' +
        'los demás; si hay activos y ninguno lo cumple, responde 500 (nunca una lista vacía). ' +
        'Los errores salen con `Cache-Control: no-store`.',
    }),
    ApiOkResponse({
      description: `Pagadores activos ordenados por nombre corto. Mensaje: «${DEFAULT_SUCCESS_MESSAGE}».`,
      standardSchema: apiSuccessEnvelopeSchema(publicPayerSchema.array()),
      headers: {
        ...CORRELATION_ID_RESPONSE_HEADER,
        'Cache-Control': {
          description: 'La landing y la CDN pueden reutilizar la lista durante cinco minutos.',
          schema: { type: 'string', example: PUBLIC_PAYERS_CACHE_CONTROL },
        },
      },
    }),
    ApiErrorResponses(...COMMON_API_ERROR_CODES),
  )
}
