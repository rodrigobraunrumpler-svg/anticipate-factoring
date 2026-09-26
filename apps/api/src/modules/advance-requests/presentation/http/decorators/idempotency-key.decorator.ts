import { createParamDecorator, type ExecutionContext } from '@nestjs/common'
import type { Request } from 'express'
import { IDEMPOTENCY_KEY_HEADER } from '#/common/constants/http-headers.constants.js'
import { apiError } from '#/common/exceptions/index.js'
import { isUuid } from '#/common/utils/uuid.js'

/**
 * La `Idempotency-Key` del envío: obligatoria, un UUID, en minúsculas (la base la guarda en una
 * columna `uuid` única). Falta, repetida o inválida: 400 `IDEMPOTENCY_KEY_INVALID`.
 */
export function readIdempotencyKey(request: Request): string {
  const key = request.get(IDEMPOTENCY_KEY_HEADER)?.trim()
  if (key === undefined || !isUuid(key)) {
    throw apiError('IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key ausente o no es un UUID')
  }
  return key.toLowerCase()
}

export const IdempotencyKey = createParamDecorator((_data: unknown, context: ExecutionContext) =>
  readIdempotencyKey(context.switchToHttp().getRequest<Request>()),
)
