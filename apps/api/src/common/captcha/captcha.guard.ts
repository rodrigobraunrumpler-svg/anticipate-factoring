import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common'
import type { Request } from 'express'
import { APP_CONFIG, type AppConfig } from '#/common/config/index.js'
import {
  CAPTCHA_TOKEN_HEADER,
  IDEMPOTENCY_KEY_HEADER,
} from '#/common/constants/http-headers.constants.js'
import { apiError } from '#/common/exceptions/index.js'
import { resolveClientIp } from '#/common/utils/client-ip.js'
import { isUuid } from '#/common/utils/uuid.js'
import {
  CAPTCHA_VERIFIER,
  type CaptchaVerificationInput,
  type CaptchaVerifierPort,
} from './captcha-verifier.port.js'

/**
 * Verifica el captcha antes de que multer lea los archivos (los guards corren antes que los
 * interceptores). Token vacío: 403 sin consultar al proveedor. Token rechazado: 403
 * `CAPTCHA_FAILED`. Proveedor sin respuesta: 503 `CAPTCHA_UNAVAILABLE`, nunca deja pasar.
 */
@Injectable()
export class CaptchaGuard implements CanActivate {
  constructor(
    @Inject(CAPTCHA_VERIFIER) private readonly verifier: CaptchaVerifierPort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>()
    const token = request.get(CAPTCHA_TOKEN_HEADER)?.trim() ?? ''
    if (token === '') throw apiError('CAPTCHA_FAILED', 'captcha: falta el token')

    const idempotencyKey = request.get(IDEMPOTENCY_KEY_HEADER)?.trim()
    const input: CaptchaVerificationInput = {
      token,
      remoteIp: resolveClientIp(request, this.config.trustCloudflareHeaders),
      ...(idempotencyKey !== undefined && isUuid(idempotencyKey)
        ? { idempotencyKey: idempotencyKey.toLowerCase() }
        : {}),
    }
    let valid: boolean
    try {
      valid = await this.verifier.verify(input)
    } catch (error) {
      throw apiError('CAPTCHA_UNAVAILABLE', 'captcha: el verificador no respondió', {
        cause: error,
      })
    }
    if (!valid) throw apiError('CAPTCHA_FAILED', 'captcha: token rechazado')
    return true
  }
}
