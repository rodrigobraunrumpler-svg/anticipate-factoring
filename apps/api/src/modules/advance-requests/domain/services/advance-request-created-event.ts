import {
  type AdvanceRequestCreatedEvent,
  advanceRequestCreatedEventSchema,
} from '@anticipate/shared/advance-request'
import type { Amount, Currency } from '@anticipate/shared/money'

export type AdvanceRequestCreatedEventInput = {
  eventId: string
  occurredAt: Date
  advanceRequestId: string
  publicCode: string
  payerSlug: string
  supplierRuc: string
  currency: Currency
  requestedAmount: Amount
  invoiceCount: number
  contactEmail: string
}

/**
 * Lo que se guarda en `outbox_events.payload`: identificadores, tipo y versión, nunca datos
 * personales. Cada handler lee lo que necesita de la base con `aggregateId` al momento de enviar.
 */
export type AdvanceRequestCreatedOutboxPayload = {
  id: string
  type: AdvanceRequestCreatedEvent['type']
  version: AdvanceRequestCreatedEvent['version']
  occurredAt: string
  aggregateId: string
}

/**
 * El evento `advance-request.created` del contrato de shared, validado con su esquema. Con datos que
 * ya pasaron las reglas nunca falla; si falla es un error de programación, y el mensaje nombra solo
 * las rutas inválidas, nunca los valores (llevan datos personales).
 */
export function buildAdvanceRequestCreatedEvent(
  input: AdvanceRequestCreatedEventInput,
): AdvanceRequestCreatedEvent {
  const result = advanceRequestCreatedEventSchema.safeParse({
    id: input.eventId,
    occurredAt: input.occurredAt.toISOString(),
    version: 1,
    type: 'advance-request.created',
    payload: {
      advanceRequestId: input.advanceRequestId,
      publicCode: input.publicCode,
      payerSlug: input.payerSlug,
      supplierRuc: input.supplierRuc,
      currency: input.currency,
      requestedAmount: input.requestedAmount,
      invoiceCount: input.invoiceCount,
      contactEmail: input.contactEmail,
    },
  })
  if (!result.success) {
    const paths = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))]
    throw new TypeError(`Evento advance-request.created inválido en: ${paths.join(', ')}`)
  }
  return result.data
}

/** Proyección del evento para el outbox: sin correo, RUC, monto ni ningún otro dato del envío. */
export function toAdvanceRequestCreatedOutboxPayload(
  event: AdvanceRequestCreatedEvent,
): AdvanceRequestCreatedOutboxPayload {
  return {
    id: event.id,
    type: event.type,
    version: event.version,
    occurredAt: event.occurredAt,
    aggregateId: event.payload.advanceRequestId,
  }
}
