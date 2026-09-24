import { describe, expect, it } from 'vitest'
import { MESSAGES_ES, VALIDATION_MESSAGES_ES } from '../errors/index.js'
import { CLOSE_REASON_LABELS, CLOSE_REASONS, CLOSE_REASONS_BY_STATUS } from './close-reasons.js'
import {
  ADVANCE_REQUEST_STATUSES,
  INITIAL_STATUS,
  isTerminalStatus,
  STATUS_LABELS,
  TERMINAL_STATUSES,
} from './statuses.js'
import {
  availableTransitions,
  evaluateStatusChange,
  type StatusChangeResult,
  statusChangeSchema,
  TRANSITIONS,
  transitionsFrom,
} from './transitions.js'

const problemCode = (r: StatusChangeResult) => (r.ok ? null : r.problem.code)

const exits = (status: string) => TRANSITIONS.filter((t) => t.from === status).map((t) => t.to)

describe('estructura de la máquina de estados', () => {
  it('no hay transiciones duplicadas', () => {
    const keys = TRANSITIONS.map((t) => `${t.from}->${t.to}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('los estados terminales no tienen salida', () => {
    for (const s of TERMINAL_STATUSES) expect(exits(s), s).toEqual([])
  })

  it('todo estado es alcanzable desde el inicial', () => {
    const seen = new Set<string>([INITIAL_STATUS])
    const queue = [INITIAL_STATUS as string]
    while (queue.length > 0) {
      const current = queue.shift() as string
      for (const next of exits(current))
        if (!seen.has(next)) {
          seen.add(next)
          queue.push(next)
        }
    }
    for (const s of ADVANCE_REQUEST_STATUSES)
      expect(seen.has(s), `${s} no es alcanzable`).toBe(true)
  })

  it('todo estado no terminal tiene camino a un estado terminal', () => {
    const reachesTerminal = (from: string, seen = new Set<string>()): boolean => {
      if (isTerminalStatus(from as never)) return true
      if (seen.has(from)) return false
      seen.add(from)
      return exits(from).some((next) => reachesTerminal(next, seen))
    }
    for (const s of ADVANCE_REQUEST_STATUSES)
      expect(reachesTerminal(s), `${s} no llega a un estado terminal`).toBe(true)
  })

  it('toda transición hacia REJECTED o WITHDRAWN exige motivo, y ninguna otra', () => {
    for (const t of TRANSITIONS) {
      const isClosure = t.to === 'REJECTED' || t.to === 'WITHDRAWN'
      expect(t.requiresReason === true, `${t.from}->${t.to}`).toBe(isClosure)
    }
  })

  it('cada estado de cierre tiene motivos definidos', () => {
    expect(CLOSE_REASONS_BY_STATUS.REJECTED.length).toBeGreaterThan(0)
    expect(CLOSE_REASONS_BY_STATUS.WITHDRAWN.length).toBeGreaterThan(0)
  })

  it('todo estado no terminal puede cerrarse directamente', () => {
    for (const s of ADVANCE_REQUEST_STATUSES) {
      if (isTerminalStatus(s)) continue
      const canClose = exits(s).some((next) => next === 'REJECTED' || next === 'WITHDRAWN')
      expect(canClose, `${s} no tiene cierre directo`).toBe(true)
    }
  })
})

describe('transitionsFrom', () => {
  it('filtra por rol mínimo', () => {
    expect(transitionsFrom('APPROVED', 'ADMIN').map((t) => t.to)).toEqual([
      'DISBURSED',
      'WITHDRAWN',
    ])
    expect(transitionsFrom('APPROVED', 'AGENT').map((t) => t.to)).toEqual(['WITHDRAWN'])
  })

  it('devuelve vacío para estados terminales', () => {
    expect(transitionsFrom('DISBURSED', 'ADMIN')).toEqual([])
  })
})

describe('availableTransitions', () => {
  it('oculta las transiciones cuya guarda no se cumple', () => {
    expect(availableTransitions('DOCUMENTS_PENDING', 'AGENT', {}).map((t) => t.to)).toEqual([
      'REJECTED',
      'WITHDRAWN',
    ])
    expect(
      availableTransitions('DOCUMENTS_PENDING', 'AGENT', { documentsValid: true }).map((t) => t.to),
    ).toEqual(['UNDER_REVIEW', 'REJECTED', 'WITHDRAWN'])
  })

  it('permite registrar el retiro del proveedor durante la evaluación', () => {
    expect(availableTransitions('UNDER_REVIEW', 'AGENT', {}).map((t) => t.to)).toEqual([
      'QUOTE_SENT',
      'REJECTED',
      'WITHDRAWN',
    ])
    const r = evaluateStatusChange({
      from: 'UNDER_REVIEW',
      to: 'WITHDRAWN',
      role: 'AGENT',
      closeReason: 'SUPPLIER_WITHDREW',
    })
    expect(r).toEqual({ ok: true, guard: null, requiresReason: true })
  })

  it('oculta la aprobación hasta que la proforma esté aceptada', () => {
    expect(availableTransitions('QUOTE_SENT', 'AGENT', {}).map((t) => t.to)).toEqual(['WITHDRAWN'])
    expect(
      availableTransitions('QUOTE_SENT', 'AGENT', { quoteAccepted: true }).map((t) => t.to),
    ).toEqual(['APPROVED', 'WITHDRAWN'])
  })
})

describe('evaluateStatusChange', () => {
  it('acepta una transición simple sin guarda', () => {
    const r = evaluateStatusChange({ from: 'NEW', to: 'CONTACTED', role: 'AGENT' })
    expect(r).toEqual({ ok: true, guard: null, requiresReason: false })
  })

  it('devuelve la guarda que la API debe comprobar', () => {
    const r = evaluateStatusChange({ from: 'DOCUMENTS_PENDING', to: 'UNDER_REVIEW', role: 'AGENT' })
    expect(r).toEqual({ ok: true, guard: 'documentsValid', requiresReason: false })
  })

  it('devuelve la guarda de proforma aceptada para aprobar', () => {
    const r = evaluateStatusChange({ from: 'QUOTE_SENT', to: 'APPROVED', role: 'AGENT' })
    expect(r).toEqual({ ok: true, guard: 'quoteAccepted', requiresReason: false })
  })

  it('rechaza una transición que no existe con un Problem en español', () => {
    const r = evaluateStatusChange({ from: 'NEW', to: 'DISBURSED', role: 'ADMIN' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.problem.code).toBe('TRANSITION_NOT_ALLOWED')
      expect(r.problem.message).toBe(MESSAGES_ES.TRANSITION_NOT_ALLOWED)
    }
  })

  it('rechaza por rol insuficiente', () => {
    const r = evaluateStatusChange({ from: 'APPROVED', to: 'DISBURSED', role: 'AGENT' })
    expect(problemCode(r)).toBe('INSUFFICIENT_ROLE')
  })

  it('exige motivo en los cierres y que sea válido para ese estado', () => {
    const missing = evaluateStatusChange({ from: 'NEW', to: 'WITHDRAWN', role: 'AGENT' })
    expect(problemCode(missing)).toBe('CLOSE_REASON_REQUIRED')
    expect(!missing.ok && missing.problem.field).toBe('closeReason')
    expect(
      problemCode(
        evaluateStatusChange({
          from: 'NEW',
          to: 'WITHDRAWN',
          role: 'AGENT',
          closeReason: 'INVALID_DOCUMENTS',
        }),
      ),
    ).toBe('CLOSE_REASON_NOT_VALID')
    expect(
      evaluateStatusChange({
        from: 'NEW',
        to: 'WITHDRAWN',
        role: 'AGENT',
        closeReason: 'SPAM_OR_INVALID',
      }),
    ).toEqual({ ok: true, guard: null, requiresReason: true })
  })

  it('rechaza un motivo o un detalle en una transición que no es de cierre', () => {
    expect(
      problemCode(
        evaluateStatusChange({
          from: 'NEW',
          to: 'CONTACTED',
          role: 'AGENT',
          closeReason: 'NO_RESPONSE',
        }),
      ),
    ).toBe('CLOSE_REASON_NOT_APPLICABLE')
    expect(
      problemCode(
        evaluateStatusChange({
          from: 'NEW',
          to: 'CONTACTED',
          role: 'AGENT',
          closeReasonDetail: 'Llamó dos veces',
        }),
      ),
    ).toBe('CLOSE_REASON_NOT_APPLICABLE')
    expect(
      evaluateStatusChange({ from: 'NEW', to: 'CONTACTED', role: 'AGENT', closeReasonDetail: ' ' }),
    ).toEqual({ ok: true, guard: null, requiresReason: false })
  })

  it('el motivo OTHER exige un detalle con texto', () => {
    const base = { from: 'NEW', to: 'WITHDRAWN', role: 'AGENT', closeReason: 'OTHER' } as const
    const r = evaluateStatusChange(base)
    expect(problemCode(r)).toBe('CLOSE_REASON_DETAIL_REQUIRED')
    expect(!r.ok && r.problem.field).toBe('closeReasonDetail')
    expect(problemCode(evaluateStatusChange({ ...base, closeReasonDetail: '   ' }))).toBe(
      'CLOSE_REASON_DETAIL_REQUIRED',
    )
    expect(evaluateStatusChange({ ...base, closeReasonDetail: 'Cambió de proveedor' })).toEqual({
      ok: true,
      guard: null,
      requiresReason: true,
    })
  })
})

describe('statusChangeSchema (cuerpo del PATCH de la API)', () => {
  it('acepta destino, versión y motivo opcional', () => {
    expect(statusChangeSchema.safeParse({ to: 'CONTACTED', version: 3 }).success).toBe(true)
    expect(
      statusChangeSchema.safeParse({
        to: 'WITHDRAWN',
        version: 3,
        closeReason: 'NO_RESPONSE',
        closeReasonDetail: 'Tres llamadas',
      }).success,
    ).toBe(true)
  })

  it('rechaza estados desconocidos y versiones no enteras, con mensajes en español', () => {
    const unknown = statusChangeSchema.safeParse({ to: 'CLOSED', version: 1 })
    expect(unknown.success).toBe(false)
    if (!unknown.success) {
      expect(unknown.error.issues[0]?.message).toBe(VALIDATION_MESSAGES_ES.advanceRequest.status)
    }
    const fractional = statusChangeSchema.safeParse({ to: 'CONTACTED', version: 1.5 })
    expect(fractional.success).toBe(false)
    if (!fractional.success) {
      expect(fractional.error.issues[0]?.message).toBe(
        VALIDATION_MESSAGES_ES.advanceRequest.version,
      )
    }
  })

  it('el motivo OTHER exige detalle también en el cuerpo del PATCH', () => {
    const r = statusChangeSchema.safeParse({ to: 'WITHDRAWN', version: 1, closeReason: 'OTHER' })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues[0]?.path).toEqual(['closeReasonDetail'])
      expect(r.error.issues[0]?.message).toBe(MESSAGES_ES.CLOSE_REASON_DETAIL_REQUIRED)
    }
    expect(
      statusChangeSchema.safeParse({
        to: 'WITHDRAWN',
        version: 1,
        closeReason: 'OTHER',
        closeReasonDetail: '  ',
      }).success,
    ).toBe(false)
    expect(
      statusChangeSchema.safeParse({
        to: 'WITHDRAWN',
        version: 1,
        closeReason: 'OTHER',
        closeReasonDetail: 'Cambió de proveedor',
      }).success,
    ).toBe(true)
  })

  it('rechaza un detalle de más de 500 caracteres con mensaje en español', () => {
    const r = statusChangeSchema.safeParse({
      to: 'WITHDRAWN',
      version: 1,
      closeReason: 'NO_RESPONSE',
      closeReasonDetail: 'x'.repeat(501),
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.issues[0]?.message).toBe(
        VALIDATION_MESSAGES_ES.advanceRequest.closeReasonDetailMax,
      )
    }
  })
})

describe('tablas del dominio', () => {
  it('todo estado y todo motivo tienen etiqueta en español', () => {
    for (const status of ADVANCE_REQUEST_STATUSES) expect(STATUS_LABELS[status]).toBeTruthy()
    for (const reason of CLOSE_REASONS) expect(CLOSE_REASON_LABELS[reason]).toBeTruthy()
  })

  it('son de solo lectura en tiempo de compilación', () => {
    // Nunca se ejecuta: solo comprueba con `tsc` que las tablas no se pueden modificar.
    const mutate = () => {
      // @ts-expect-error la tabla es de solo lectura
      STATUS_LABELS.NEW = 'x'
      // @ts-expect-error la tabla es de solo lectura
      CLOSE_REASON_LABELS.OTHER = 'x'
      const [first] = TRANSITIONS
      if (first) {
        // @ts-expect-error cada transición es de solo lectura
        first.to = 'DISBURSED'
      }
      // @ts-expect-error la tabla es de solo lectura
      TRANSITIONS.push({ from: 'NEW', to: 'DISBURSED' })
    }
    expect(mutate).toBeTypeOf('function')
  })
})
