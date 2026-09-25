import { Injectable, type NestMiddleware } from '@nestjs/common'
import type { NextFunction, Request, Response } from 'express'
import { CORRELATION_ID_HEADER } from '#/common/constants/http-headers.constants.js'
import { resolveCorrelationId } from '#/common/utils/correlation-id.js'

/**
 * Primera pieza de toda petición: `setupApp` la monta con `app.use` antes que helmet, CORS y los
 * parsers, así que corre en todas las rutas, también en un 404, en `/health` y en un preflight de
 * CORS. Fija `req.correlationId` y lo devuelve en la cabecera `x-correlation-id`.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware<Request, Response> {
  use(req: Request, res: Response, next: NextFunction): void {
    res.setHeader(CORRELATION_ID_HEADER, resolveCorrelationId(req))
    next()
  }
}
