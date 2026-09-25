import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { resolveCorrelationId } from './correlation-id.js'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function requestWith(header?: string): IncomingMessage & { correlationId?: string } {
  const headers = header === undefined ? {} : { 'x-correlation-id': header }
  return { headers } as unknown as IncomingMessage & { correlationId?: string }
}

describe('resolveCorrelationId', () => {
  it('conserva una cabecera válida y la deja en req.correlationId', () => {
    const req = requestWith('pedido-123.A_b')
    expect(resolveCorrelationId(req)).toBe('pedido-123.A_b')
    expect(req.correlationId).toBe('pedido-123.A_b')
  })

  it('acepta hasta 128 caracteres', () => {
    expect(resolveCorrelationId(requestWith('a'.repeat(128)))).toBe('a'.repeat(128))
  })

  it.each([
    ['ausente', undefined],
    ['vacía', ''],
    ['con espacios', 'con espacio'],
    ['repetida (Node la une con ", ")', 'uno, dos'],
    ['de más de 128 caracteres', 'a'.repeat(129)],
    ['con caracteres fuera del formato', 'ñandú'],
  ])('reemplaza por un UUID nuevo una cabecera %s', (_case, header) => {
    const req = requestWith(header)
    const correlationId = resolveCorrelationId(req)
    expect(correlationId).toMatch(UUID_V4)
    expect(req.correlationId).toBe(correlationId)
  })

  it('resuelve una sola vez: las llamadas siguientes devuelven el mismo id', () => {
    const req = requestWith()
    expect(resolveCorrelationId(req)).toBe(resolveCorrelationId(req))
  })
})
