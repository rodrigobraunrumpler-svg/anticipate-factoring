import type { Request } from 'express'

/** Un `Content-Length` es un entero decimal; 15 dígitos alcanzan de sobra y caben en un `number`. */
const DECLARED_LENGTH = /^\d{1,15}$/

/**
 * El `Content-Length` de la petición, o `null` si no lo trae (envío chunked) o no es un entero
 * decimal. Node nunca entrega más cuerpo que este: lo que venga después es otra petición.
 */
export function declaredContentLength(request: Request): number | null {
  const declared = request.headers['content-length']
  return declared !== undefined && DECLARED_LENGTH.test(declared) ? Number(declared) : null
}
