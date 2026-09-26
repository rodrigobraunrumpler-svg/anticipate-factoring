/** UUID canónico de RFC 9562: versión 1 a 8 y variante `10xx`, en minúsculas o mayúsculas. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * ¿`value` es un UUID? Lo usan el guard del captcha y `@IdempotencyKey()` para la cabecera
 * `Idempotency-Key`, que la base guarda en una columna `uuid`.
 */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}
