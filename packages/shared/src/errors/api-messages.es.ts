/**
 * Textos para personas de las respuestas de la API: el mensaje de cada código de error del sobre y
 * los mensajes de éxito. Viven aquí con el resto del texto en español; `@anticipate/shared/api` los
 * publica tipados por código (`API_ERROR_MESSAGES_ES`, `DEFAULT_SUCCESS_MESSAGE` y
 * `SUCCESS_MESSAGES_ES`), igual que `FORM_MESSAGES` publica los del formulario. Son textos finales,
 * sin marcadores: la API los envía tal cual.
 */
export const API_MESSAGES_ES = {
  errors: {
    BAD_REQUEST: 'La solicitud no tiene el formato esperado.',
    VALIDATION_ERROR: 'Revisa los datos enviados.',
    MALFORMED_JSON: 'El cuerpo de la solicitud no es un JSON válido.',
    MALFORMED_MULTIPART: 'El envío de archivos no tiene el formato esperado.',
    TOO_MANY_FILES: 'Adjuntaste más archivos de los permitidos.',
    UNEXPECTED_FILE_FIELD:
      'El envío trae archivos en un campo no permitido. Usa los campos xml y pdf.',
    IDEMPOTENCY_KEY_INVALID: 'Falta la cabecera Idempotency-Key o no es un UUID válido.',
    CAPTCHA_FAILED:
      'No pudimos verificar que eres una persona. Recarga la página e inténtalo de nuevo.',
    RESOURCE_NOT_FOUND: 'La ruta solicitada no existe.',
    CONFLICT: 'La información cambió mientras la editabas. Recarga e inténtalo de nuevo.',
    LENGTH_REQUIRED: 'El envío debe indicar su tamaño (Content-Length).',
    PAYLOAD_TOO_LARGE: 'El envío supera el tamaño máximo permitido.',
    BUSINESS_RULES_VIOLATED:
      'La solicitud no cumple las condiciones del programa. Revisa el detalle.',
    IDEMPOTENCY_KEY_REUSED:
      'Esta clave de envío ya se usó con otros datos. Recarga la página e inténtalo de nuevo.',
    RATE_LIMIT_EXCEEDED: 'Hiciste demasiados envíos seguidos. Inténtalo de nuevo más tarde.',
    INTERNAL_ERROR: 'Ocurrió un error inesperado. Inténtalo de nuevo.',
    SERVICE_UNAVAILABLE:
      'No pudimos procesar tu solicitud en este momento. Inténtalo de nuevo en unos minutos.',
    CAPTCHA_UNAVAILABLE:
      'No pudimos verificar el captcha en este momento. Inténtalo de nuevo en unos minutos.',
  },
  /** Mensaje del sobre de éxito cuando el endpoint no declara uno propio. */
  defaultSuccess: 'Operación realizada.',
  /** Mensajes de éxito propios de un endpoint (`@ResponseMessage()` en la API). */
  success: {
    advanceRequestCreated: 'Solicitud recibida.',
  },
} as const
