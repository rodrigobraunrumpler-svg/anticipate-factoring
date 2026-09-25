import { type CustomDecorator, SetMetadata } from '@nestjs/common'

export const SKIP_RESPONSE_ENVELOPE_KEY = 'anticipate:skip-response-envelope'

/**
 * Deja una ruta o un controlador fuera del sobre de éxito: su cuerpo lo define otro contrato (los
 * chequeos de salud devuelven el cuerpo de Terminus). Los errores siguen saliendo con el sobre.
 */
export function SkipResponseEnvelope(): CustomDecorator<string> {
  return SetMetadata(SKIP_RESPONSE_ENVELOPE_KEY, true)
}
