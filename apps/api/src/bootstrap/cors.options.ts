import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface.js'
import {
  CAPTCHA_TOKEN_HEADER,
  CORRELATION_ID_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
} from '#/common/constants/http-headers.constants.js'

/** Cuánto guarda el navegador un preflight aprobado. */
const PREFLIGHT_MAX_AGE_SECONDS = 600

/**
 * CORS con lista blanca exacta (`CORS_ORIGINS`): un origen que no está recibe la respuesta sin
 * `Access-Control-Allow-Origin` y el navegador la bloquea. Sin cookies (`credentials: false`). Los
 * métodos son los que sirve la API hoy; el admin del paso 4 agrega los suyos.
 */
export function createCorsOptions(allowedOrigins: readonly string[]): CorsOptions {
  return {
    origin: [...allowedOrigins],
    methods: ['GET', 'HEAD', 'POST'],
    allowedHeaders: [
      'Content-Type',
      CORRELATION_ID_HEADER,
      IDEMPOTENCY_KEY_HEADER,
      CAPTCHA_TOKEN_HEADER,
    ],
    exposedHeaders: [CORRELATION_ID_HEADER, IDEMPOTENT_REPLAYED_HEADER, 'Retry-After'],
    credentials: false,
    maxAge: PREFLIGHT_MAX_AGE_SECONDS,
  }
}
