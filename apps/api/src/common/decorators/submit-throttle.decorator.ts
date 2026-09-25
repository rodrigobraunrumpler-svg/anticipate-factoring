import { type ExecutionContext, SetMetadata } from '@nestjs/common'
import { Reflector } from '@nestjs/core'

const SUBMIT_THROTTLE_KEY = 'anticipate:submit-throttle'

const reflector = new Reflector()

/**
 * Marca una ruta pública de envío: además del límite general, cuenta para el límite de envíos por IP
 * (`THROTTLE_SUBMIT_LIMIT` en `THROTTLE_SUBMIT_TTL_SECONDS`). Va en el método o en el controlador.
 */
export const SubmitThrottle = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SUBMIT_THROTTLE_KEY, true)

/** Si la ruta que atiende `context` lleva `@SubmitThrottle()`, en el método o en su controlador. */
export function isSubmitRoute(context: ExecutionContext): boolean {
  return (
    reflector.getAllAndOverride<boolean | undefined>(SUBMIT_THROTTLE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) === true
  )
}
