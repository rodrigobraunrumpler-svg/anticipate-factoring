import { Inject, Injectable, type NestMiddleware } from '@nestjs/common'
import type { NextFunction, Request, Response } from 'express'
import { APP_CONFIG, type AppConfig } from '#/common/config/index.js'
import { apiError } from '#/common/exceptions/index.js'
import { declaredContentLength } from '#/common/utils/content-length.js'

/**
 * Tope del cuerpo por `Content-Length`, antes de leer un solo byte: sin tamaño declarado (envío
 * chunked) o con uno inválido, 411 `LENGTH_REQUIRED`; mayor que `UPLOAD_MAX_BODY_BYTES`, 413
 * `PAYLOAD_TOO_LARGE`. Se aplica con `forRoutes(Controlador)`: el guard del captcha y multer ni
 * siquiera corren.
 */
@Injectable()
export class ContentLengthLimitMiddleware implements NestMiddleware<Request, Response> {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  use(request: Request, _response: Response, next: NextFunction): void {
    const declared = declaredContentLength(request)
    if (declared === null) {
      throw apiError('LENGTH_REQUIRED', 'cuerpo sin Content-Length válido')
    }
    if (declared > this.config.upload.maxBodyBytes) {
      throw apiError('PAYLOAD_TOO_LARGE', 'Content-Length mayor que UPLOAD_MAX_BODY_BYTES')
    }
    next()
  }
}
