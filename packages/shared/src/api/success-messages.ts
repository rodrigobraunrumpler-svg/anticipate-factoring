import { API_MESSAGES_ES } from '../errors/index.js'

/** `message` del sobre de éxito cuando el endpoint no declara uno propio con `@ResponseMessage()`. */
export const DEFAULT_SUCCESS_MESSAGE: string = API_MESSAGES_ES.defaultSuccess

/** Mensajes de éxito propios de cada endpoint. El texto vive en `errors` (`API_MESSAGES_ES.success`). */
export const SUCCESS_MESSAGES_ES: Readonly<Record<keyof typeof API_MESSAGES_ES.success, string>> =
  API_MESSAGES_ES.success
