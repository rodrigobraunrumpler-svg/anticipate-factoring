import { advanceRequestCreatedSchema } from '@anticipate/shared/advance-request'
import { SUCCESS_MESSAGES_ES } from '@anticipate/shared/api'
import { applyDecorators } from '@nestjs/common'
import { ApiBody, ApiConsumes, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  CAPTCHA_TOKEN_HEADER,
  CORRELATION_ID_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
} from '#/common/constants/http-headers.constants.js'
import { ApiEnvelopedResponse } from '#/common/swagger/api-enveloped-response.swagger.js'
import {
  ApiErrorResponses,
  COMMON_API_ERROR_CODES,
} from '#/common/swagger/api-error-responses.swagger.js'
import {
  ADVANCE_REQUEST_FILE_FIELD,
  ADVANCE_REQUEST_FORM_FIELD,
} from '#/modules/advance-requests/presentation/http/constants/multipart.constants.js'

export const ADVANCE_REQUESTS_API_TAG = 'Solicitudes de adelanto'

const FORM_EXAMPLE = {
  payerSlug: 'sea',
  contact: {
    fullName: 'Ana Pérez',
    dni: '46728673',
    mobile: '987654321',
    email: 'ana@proveedor.pe',
    isLegalRepresentative: true,
    contactTimeSlot: 'MORNING',
  },
  company: { ruc: '20100070970', legalName: 'PROVEEDOR EJEMPLO S.A.C.' },
  financing: { requestedAmount: '8000.00' },
  cavaliRegistration: 'UNKNOWN',
  consents: { terms: true, personalData: true, termsVersion: '2026-09', privacyVersion: '2026-09' },
}

/** Tag de la ruta, para el controlador. */
export const AdvanceRequestsApiTags = () => ApiTags(ADVANCE_REQUESTS_API_TAG)

/** Documentación de `POST /api/v1/advance-requests`: multipart, cabeceras, 201 y cada error. */
export function CreateAdvanceRequestDocs() {
  return applyDecorators(
    ApiOperation({
      summary: 'Recibe una solicitud de adelanto con sus facturas',
      description:
        'Multipart con el formulario en JSON (`form`), los XML de las facturas (`xml`) y sus PDF opcionales (`pdf`, emparejados por nombre). Un reintento con la misma `Idempotency-Key` y los mismos datos responde lo mismo, con la cabecera `Idempotent-Replayed: true`.',
    }),
    ApiConsumes('multipart/form-data'),
    ApiHeader({
      name: CAPTCHA_TOKEN_HEADER,
      required: true,
      description: 'Token de Cloudflare Turnstile. La landing pide uno nuevo en cada reintento.',
    }),
    ApiHeader({
      name: IDEMPOTENCY_KEY_HEADER,
      required: true,
      description: 'UUID del envío: el mismo en todos sus reintentos.',
      schema: { type: 'string', format: 'uuid' },
    }),
    ApiHeader({
      name: CORRELATION_ID_HEADER,
      required: false,
      description: 'Id de correlación opcional (1 a 128 caracteres: letras, dígitos, . _ -).',
    }),
    ApiBody({
      schema: {
        type: 'object',
        required: [ADVANCE_REQUEST_FORM_FIELD, ADVANCE_REQUEST_FILE_FIELD.xml],
        properties: {
          [ADVANCE_REQUEST_FORM_FIELD]: {
            type: 'string',
            description: 'Formulario en JSON, validado con `advanceRequestFormSchema`.',
            example: JSON.stringify(FORM_EXAMPLE),
          },
          [ADVANCE_REQUEST_FILE_FIELD.xml]: {
            type: 'array',
            description: 'XML UBL de cada factura (al menos uno).',
            items: { type: 'string', format: 'binary' },
          },
          [ADVANCE_REQUEST_FILE_FIELD.pdf]: {
            type: 'array',
            description: 'PDF de cada factura, con el mismo nombre base que su XML (opcional).',
            items: { type: 'string', format: 'binary' },
          },
        },
      },
    }),
    ApiEnvelopedResponse({
      status: 201,
      description: `Solicitud recibida (o reintento repetido, con \`${IDEMPOTENT_REPLAYED_HEADER}: true\`).`,
      data: advanceRequestCreatedSchema,
      message: SUCCESS_MESSAGES_ES.advanceRequestCreated,
    }),
    ApiErrorResponses(
      'VALIDATION_ERROR',
      'MALFORMED_MULTIPART',
      'TOO_MANY_FILES',
      'UNEXPECTED_FILE_FIELD',
      'IDEMPOTENCY_KEY_INVALID',
      'CAPTCHA_FAILED',
      'LENGTH_REQUIRED',
      'PAYLOAD_TOO_LARGE',
      'BUSINESS_RULES_VIOLATED',
      'IDEMPOTENCY_KEY_REUSED',
      'CAPTCHA_UNAVAILABLE',
      ...COMMON_API_ERROR_CODES,
    ),
  )
}
