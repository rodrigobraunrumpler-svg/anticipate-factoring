import type { Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { isApplicationError } from '#/common/exceptions/index.js'
import { testConfig } from '../../../test/support/config.js'
import { ContentLengthLimitMiddleware } from './content-length-limit.middleware.js'

const middleware = new ContentLengthLimitMiddleware(testConfig({ UPLOAD_MAX_BODY_BYTES: '1000' }))

function run(headers: Record<string, string>): { code: string | null; next: boolean } {
  const next = vi.fn()
  try {
    middleware.use({ headers } as Request, {} as Response, next)
  } catch (error) {
    if (!isApplicationError(error)) throw error
    return { code: error.publicCode, next: next.mock.calls.length > 0 }
  }
  return { code: null, next: next.mock.calls.length > 0 }
}

describe('ContentLengthLimitMiddleware', () => {
  it('deja pasar un cuerpo dentro del tope', () => {
    expect(run({ 'content-length': '1000' })).toEqual({ code: null, next: true })
    expect(run({ 'content-length': '0' })).toEqual({ code: null, next: true })
  })

  it('sin Content-Length (chunked) o con uno inválido: 411 LENGTH_REQUIRED', () => {
    expect(run({ 'transfer-encoding': 'chunked' })).toEqual({
      code: 'LENGTH_REQUIRED',
      next: false,
    })
    expect(run({ 'content-length': '1e3' })).toEqual({ code: 'LENGTH_REQUIRED', next: false })
    expect(run({ 'content-length': '-1' })).toEqual({ code: 'LENGTH_REQUIRED', next: false })
  })

  it('mayor que el tope: 413 PAYLOAD_TOO_LARGE', () => {
    expect(run({ 'content-length': '1001' })).toEqual({ code: 'PAYLOAD_TOO_LARGE', next: false })
  })
})
