import { z } from 'zod'
import { rucSchema } from '../identity/index.js'
import { amountSchema, currencySchema } from '../money/index.js'
import { slugSchema } from '../payer/index.js'
import { closeReasonSchema } from './close-reasons.js'
import { publicCodeSchema } from './public-code.js'
import { advanceRequestStatusSchema } from './statuses.js'

export const EVENT_TYPES = ['advance-request.created', 'advance-request.status-changed'] as const
export type EventType = (typeof EVENT_TYPES)[number]

const baseEventSchema = z.object({
  id: z.uuid(),
  occurredAt: z.iso.datetime(),
  /** Versión del esquema del evento. Se incrementa si cambia el payload de forma incompatible. */
  version: z.literal(1),
})

export const advanceRequestCreatedEventSchema = baseEventSchema.extend({
  type: z.literal('advance-request.created'),
  payload: z.object({
    advanceRequestId: z.uuid(),
    publicCode: publicCodeSchema,
    payerSlug: slugSchema,
    supplierRuc: rucSchema,
    currency: currencySchema,
    requestedAmount: amountSchema,
    invoiceCount: z.number().int().positive(),
    contactEmail: z.email(),
  }),
})
export type AdvanceRequestCreatedEvent = z.infer<typeof advanceRequestCreatedEventSchema>

export const statusChangedEventSchema = baseEventSchema.extend({
  type: z.literal('advance-request.status-changed'),
  payload: z.object({
    advanceRequestId: z.uuid(),
    publicCode: publicCodeSchema,
    from: advanceRequestStatusSchema,
    to: advanceRequestStatusSchema,
    closeReason: closeReasonSchema.nullable(),
    /**
     * null cuando el cambio lo hace el sistema (por ejemplo, un cierre automático). La creación de la
     * solicitud no emite este evento con `from` nulo: emite `advance-request.created`.
     */
    changedByUserId: z.uuid().nullable(),
  }),
})
export type StatusChangedEvent = z.infer<typeof statusChangedEventSchema>

export const domainEventSchema = z.discriminatedUnion('type', [
  advanceRequestCreatedEventSchema,
  statusChangedEventSchema,
])
export type DomainEvent = z.infer<typeof domainEventSchema>
