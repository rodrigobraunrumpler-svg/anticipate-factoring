import type { AdvanceRequestCreated } from '@anticipate/shared/advance-request'
import type { CreateAdvanceRequestOutput } from '#/modules/advance-requests/application/types/create-advance-request.types.js'

/** `data` del 201: solo el código público; `replayed` va en la cabecera `Idempotent-Replayed`. */
export function toAdvanceRequestCreated({
  publicCode,
}: CreateAdvanceRequestOutput): AdvanceRequestCreated {
  return { publicCode }
}
