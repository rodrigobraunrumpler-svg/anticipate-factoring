import { describe, expect, expectTypeOf, it } from 'vitest'
import { apiSuccessEnvelopeSchema, SUCCESS_MESSAGES_ES } from '../api/index.js'
import { type AdvanceRequestCreated, advanceRequestCreatedSchema } from './responses.js'

describe('advanceRequestCreatedSchema', () => {
  it('acepta el código público y lo devuelve canónico', () => {
    expect(advanceRequestCreatedSchema.parse({ publicCode: 'ant-2026-000123' })).toEqual({
      publicCode: 'ANT-2026-000123',
    })
  })

  it('rechaza un código ajeno o ausente', () => {
    expect(advanceRequestCreatedSchema.safeParse({ publicCode: '2026-000123' }).success).toBe(false)
    expect(advanceRequestCreatedSchema.safeParse({}).success).toBe(false)
  })

  it('es el data del sobre de éxito de POST /api/v1/advance-requests', () => {
    const envelope = {
      success: true,
      statusCode: 201,
      message: SUCCESS_MESSAGES_ES.advanceRequestCreated,
      data: { publicCode: 'ANT-2026-000123' },
      correlationId: 'b3c1f0e2-4d5a-4b6c-8d7e-9f0a1b2c3d4e',
      timestamp: '2026-09-24T15:04:05.000Z',
    }
    expect(apiSuccessEnvelopeSchema(advanceRequestCreatedSchema).parse(envelope)).toEqual(envelope)
  })

  it('su tipo es solo el código público', () => {
    expectTypeOf<AdvanceRequestCreated>().toEqualTypeOf<{ publicCode: string }>()
  })
})
