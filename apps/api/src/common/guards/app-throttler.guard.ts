import { type ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  normalizeIp,
  ThrottlerGuard,
  type ThrottlerLimitDetail,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler'
import type { Request, Response } from 'express'
import { APP_CONFIG, type AppConfig } from '#/common/config/index.js'
import { isSubmitRoute } from '#/common/decorators/submit-throttle.decorator.js'
import { resolveClientIp } from '#/common/utils/client-ip.js'

/** Nombres de los dos límites. `default` no lleva sufijo en las cabeceras `X-RateLimit-*`. */
export const THROTTLER_NAMES = { default: 'default', submit: 'submit' } as const

/**
 * Límites de la API: `default` en toda ruta (salvo `@SkipThrottle()`) y `submit` solo en las rutas con
 * `@SubmitThrottle()`. Los dos cuentan por la IP real del cliente (ver `AppThrottlerGuard`).
 */
export function createThrottlerOptions(throttle: AppConfig['throttle']): ThrottlerModuleOptions {
  return {
    throttlers: [
      {
        name: THROTTLER_NAMES.default,
        limit: throttle.defaultLimit,
        ttl: throttle.defaultTtlMs,
      },
      {
        name: THROTTLER_NAMES.submit,
        limit: throttle.submitLimit,
        ttl: throttle.submitTtlMs,
        skipIf: (context) => !isSubmitRoute(context),
      },
    ],
  }
}

/**
 * Guard global de límites (`APP_GUARD`). Cuenta por la IP real del cliente (`resolveClientIp`, con
 * `CF-Connecting-IP` si la configuración lo permite), agrupando IPv6 por su subred /64, y al cortar
 * responde con `Retry-After` en segundos para cualquiera de los dos límites. La traducción al sobre
 * de error en español la hace el filtro global.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  private readonly limitLogger = new Logger(AppThrottlerGuard.name)

  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    super(options, storageService, reflector)
  }

  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const ip = resolveClientIp(req as unknown as Request, this.config.trustCloudflareHeaders)
    return Promise.resolve(normalizeIp(ip, this.ipv6SubnetPrefix))
  }

  protected override async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    context
      .switchToHttp()
      .getResponse<Response>()
      .setHeader('Retry-After', String(detail.timeToBlockExpire))
    this.limitLogger.warn(
      `Límite de peticiones alcanzado en ${context.getClass().name}.${context.getHandler().name}; se libera en ${detail.timeToBlockExpire} s`,
    )
    await super.throwThrottlingException(context, detail)
  }
}
