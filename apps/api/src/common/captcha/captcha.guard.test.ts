import type { ExecutionContext } from '@nestjs/common'
import type { Request } from 'express'
import { describe, expect, it } from 'vitest'
import { isApplicationError } from '#/common/exceptions/index.js'
import { testConfig } from '../../../test/support/config.js'
import { CaptchaGuard } from './captcha.guard.js'
import {
  CaptchaProviderRefusedError,
  type CaptchaVerificationInput,
  type CaptchaVerifierPort,
} from './captcha-verifier.port.js'

const KEY = '0192f3a0-7c1e-7d2a-9b3c-4d5e6f708192'

class RecordingVerifier implements CaptchaVerifierPort {
  readonly inputs: CaptchaVerificationInput[] = []
  constructor(private readonly answer: boolean | Error) {}
  async verify(input: CaptchaVerificationInput): Promise<boolean> {
    this.inputs.push(input)
    if (this.answer instanceof Error) throw this.answer
    return this.answer
  }
}

function contextWith(headers: Record<string, string>): ExecutionContext {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  const request = {
    headers: lower,
    ip: '203.0.113.7',
    socket: {},
    get: (name: string) => lower[name.toLowerCase()],
  } as unknown as Request
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (isApplicationError(error)) return error.publicCode
    throw error
  }
  throw new Error('se esperaba un rechazo')
}

describe('CaptchaGuard', () => {
  const config = testConfig()

  it('deja pasar un token válido y le pasa la IP y la clave del envío en minúsculas', async () => {
    const verifier = new RecordingVerifier(true)
    const guard = new CaptchaGuard(verifier, config)
    await expect(
      guard.canActivate(
        contextWith({ 'x-turnstile-token': ' token ', 'Idempotency-Key': KEY.toUpperCase() }),
      ),
    ).resolves.toBe(true)
    expect(verifier.inputs).toEqual([
      { token: 'token', remoteIp: '203.0.113.7', idempotencyKey: KEY },
    ])
  })

  it('no pasa una clave que no es UUID', async () => {
    const verifier = new RecordingVerifier(true)
    await new CaptchaGuard(verifier, config).canActivate(
      contextWith({ 'x-turnstile-token': 't', 'idempotency-key': 'no-es-uuid' }),
    )
    expect(verifier.inputs[0]).not.toHaveProperty('idempotencyKey')
  })

  it('sin token: 403 CAPTCHA_FAILED sin consultar al verificador', async () => {
    const verifier = new RecordingVerifier(true)
    const guard = new CaptchaGuard(verifier, config)
    expect(await rejection(guard.canActivate(contextWith({})))).toBe('CAPTCHA_FAILED')
    expect(await rejection(guard.canActivate(contextWith({ 'x-turnstile-token': '  ' })))).toBe(
      'CAPTCHA_FAILED',
    )
    expect(verifier.inputs).toEqual([])
  })

  it('token rechazado: 403 CAPTCHA_FAILED', async () => {
    const guard = new CaptchaGuard(new RecordingVerifier(false), config)
    expect(await rejection(guard.canActivate(contextWith({ 'x-turnstile-token': 't' })))).toBe(
      'CAPTCHA_FAILED',
    )
  })

  it('verificador sin respuesta: 503 CAPTCHA_UNAVAILABLE', async () => {
    const guard = new CaptchaGuard(new RecordingVerifier(new Error('fetch failed')), config)
    expect(await rejection(guard.canActivate(contextWith({ 'x-turnstile-token': 't' })))).toBe(
      'CAPTCHA_UNAVAILABLE',
    )
  })

  it('el proveedor rechaza nuestra verificación (clave secreta, petición): 503 SERVICE_UNAVAILABLE, nunca 403', async () => {
    const guard = new CaptchaGuard(
      new RecordingVerifier(new CaptchaProviderRefusedError(['invalid-input-secret'])),
      config,
    )
    expect(await rejection(guard.canActivate(contextWith({ 'x-turnstile-token': 't' })))).toBe(
      'SERVICE_UNAVAILABLE',
    )
  })
})
