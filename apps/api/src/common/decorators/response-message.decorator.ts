import { type CustomDecorator, SetMetadata } from '@nestjs/common'

export const RESPONSE_MESSAGE_KEY = 'anticipate:response-message'

/**
 * Mensaje en español del sobre de éxito de esta ruta o controlador, en vez de
 * `DEFAULT_SUCCESS_MESSAGE`. Los mensajes viven en `SUCCESS_MESSAGES_ES` de `shared`.
 */
export function ResponseMessage(message: string): CustomDecorator<string> {
  if (typeof message !== 'string' || message.trim() === '') {
    throw new TypeError('@ResponseMessage() necesita un mensaje no vacío')
  }
  return SetMetadata(RESPONSE_MESSAGE_KEY, message)
}
