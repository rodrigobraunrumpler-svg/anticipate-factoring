/**
 * Un carácter que XML 1.0 no admite (§2.2, producción `Char`): todo control C0 salvo tabulación,
 * salto de línea y retorno de carro; un sustituto suelto (con la bandera `u` un par bien formado es
 * un solo carácter y nunca coincide); y U+FFFE y U+FFFF. Un XML bien formado no trae ninguno, ni
 * escrito tal cual ni por referencia (`&#0;`).
 *
 * Entre ellos está U+0000, que PostgreSQL no guarda en `text` ni en `varchar`. Por eso es también la
 * gemela del tipo de las columnas de texto de la base: un texto que cumple esto nunca hace fallar un
 * INSERT por su codificación, y ninguno se guarda cambiado (un sustituto suelto llegaría como U+FFFD).
 * Vale igual para un texto dentro de `jsonb`, que rechaza `\u0000` (22P05) y un sustituto suelto
 * (22P02). Lo usan el lector del XML (`invoice`) y todo texto libre que llega de afuera, como el
 * formulario de la solicitud (`advance-request`).
 */
const NON_XML_CHAR = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u

/** Mayor punto de código de Unicode. */
const MAX_CODE_POINT = 0x10ffff

/** Si todo el texto está hecho de caracteres que XML 1.0 admite. */
export function isXmlText(text: string): boolean {
  return !NON_XML_CHAR.test(text)
}

/** Si el punto de código es un carácter que XML 1.0 admite; `false` si ni siquiera es un punto de código. */
export function isXmlCodePoint(codePoint: number): boolean {
  return (
    Number.isInteger(codePoint) &&
    codePoint >= 0 &&
    codePoint <= MAX_CODE_POINT &&
    isXmlText(String.fromCodePoint(codePoint))
  )
}
