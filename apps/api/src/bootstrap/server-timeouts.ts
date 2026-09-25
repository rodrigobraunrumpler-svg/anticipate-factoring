import type { Server } from 'node:http'
import type { AppConfig } from '#/common/config/index.js'

/**
 * Tiempos del servidor HTTP de Node: tope para recibir las cabeceras y la petición completa (frena a
 * los clientes lentos a propósito) y cuánto se mantiene abierta una conexión ociosa. El keep-alive
 * supera al del proxy inverso para que el proxy nunca reuse una conexión que Node ya cerró.
 */
export function configureServerTimeouts(server: Server, timeouts: AppConfig['server']): void {
  server.requestTimeout = timeouts.requestTimeoutMs
  server.headersTimeout = timeouts.headersTimeoutMs
  server.keepAliveTimeout = timeouts.keepAliveTimeoutMs
}
