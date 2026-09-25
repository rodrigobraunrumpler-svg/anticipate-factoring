import { type ApiSuccessEnvelope, DEFAULT_SUCCESS_MESSAGE } from '@anticipate/shared/api'
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  StreamableFile,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request, Response } from 'express'
import { map, type Observable } from 'rxjs'
import { RESPONSE_MESSAGE_KEY } from '#/common/decorators/response-message.decorator.js'
import { SKIP_RESPONSE_ENVELOPE_KEY } from '#/common/decorators/skip-response-envelope.decorator.js'
import { CursorPaginatedList, PaginatedList } from '#/common/types/paginated-list.js'
import { resolveCorrelationId } from '#/common/utils/correlation-id.js'

/**
 * Envuelve toda respuesta exitosa en el sobre de `@anticipate/shared/api`, con la misma forma que
 * los errores de `AllExceptionsFilter`. `PaginatedList` sale como `data` + `metadataPagination` y
 * `CursorPaginatedList` como `data` + `metadataCursor`. Se omite con `@SkipResponseEnvelope()` y el
 * mensaje se cambia con `@ResponseMessage()`.
 */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle()
    const targets = [context.getHandler(), context.getClass()]
    if (
      this.reflector.getAllAndOverride<boolean | undefined>(SKIP_RESPONSE_ENVELOPE_KEY, targets)
    ) {
      return next.handle()
    }
    const message =
      this.reflector.getAllAndOverride<string | undefined>(RESPONSE_MESSAGE_KEY, targets) ??
      DEFAULT_SUCCESS_MESSAGE
    const http = context.switchToHttp()
    const request = http.getRequest<Request>()
    const response = http.getResponse<Response>()

    return next.handle().pipe(
      map((result: unknown) => {
        if (result instanceof StreamableFile) return result
        const base = {
          success: true as const,
          statusCode: response.statusCode,
          message,
          correlationId: request.correlationId ?? resolveCorrelationId(request),
          timestamp: new Date().toISOString(),
        }
        if (result instanceof PaginatedList) {
          return {
            ...base,
            data: [...result.items],
            metadataPagination: { ...result.meta },
          } satisfies ApiSuccessEnvelope<unknown[]>
        }
        if (result instanceof CursorPaginatedList) {
          return {
            ...base,
            data: [...result.items],
            metadataCursor: { ...result.meta },
          } satisfies ApiSuccessEnvelope<unknown[]>
        }
        return { ...base, data: result ?? null } satisfies ApiSuccessEnvelope<unknown>
      }),
    )
  }
}
