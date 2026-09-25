/**
 * Cabeceras propias del contrato HTTP de la API, en minúsculas (así las entrega Node en `req.headers`).
 * Son valores técnicos fijos: cambiar uno rompe a la landing y al admin.
 */

/** Id de correlación: entra opcional y sale siempre en la respuesta. */
export const CORRELATION_ID_HEADER = 'x-correlation-id'

/** Clave de idempotencia del envío de una solicitud (UUID, la misma en cada reintento). */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key'

/** Sale con valor `true` cuando la respuesta repite un envío ya guardado. */
export const IDEMPOTENT_REPLAYED_HEADER = 'idempotent-replayed'

/** Token de Cloudflare Turnstile del formulario público. */
export const CAPTCHA_TOKEN_HEADER = 'x-turnstile-token'
