import type { Problem } from '@anticipate/shared/errors'
import { ApplicationError } from './application-error.js'

export type BusinessRulesViolatedDetails = { readonly problems: readonly Problem[] }

/**
 * 422 `BUSINESS_RULES_VIOLATED` con todos los problemas juntos en `details.problems`. Los problemas
 * se crean con `createProblem` de `shared`. Una lista vacía es un error de programación: si no hay
 * problemas, no hay nada que rechazar.
 */
export class BusinessRulesViolatedError extends ApplicationError<
  'BUSINESS_RULES_VIOLATED',
  BusinessRulesViolatedDetails
> {
  constructor(problems: readonly Problem[], diagnostic?: string) {
    if (!Array.isArray(problems) || problems.length === 0) {
      throw new TypeError('BusinessRulesViolatedError necesita al menos un problema')
    }
    super('BUSINESS_RULES_VIOLATED', { details: { problems }, diagnostic })
  }

  get problems(): readonly Problem[] {
    return this.publicDetails?.problems ?? []
  }
}
