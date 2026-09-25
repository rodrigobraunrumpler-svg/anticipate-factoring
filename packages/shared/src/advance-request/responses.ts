import { z } from 'zod'
import { publicCodeSchema } from './public-code.js'

/**
 * `data` de la respuesta 201 de `POST /api/v1/advance-requests` (y de su reintento con la misma
 * `Idempotency-Key`): solo el código público, que la landing muestra y el proveedor usa al escribir.
 */
export const advanceRequestCreatedSchema = z.object({ publicCode: publicCodeSchema })
export type AdvanceRequestCreated = z.infer<typeof advanceRequestCreatedSchema>
