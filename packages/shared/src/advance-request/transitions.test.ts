import { describe, expect, it } from 'vitest'
import { CLOSE_REASONS_BY_STATUS } from './close-reasons.js'
import {
  ADVANCE_REQUEST_STATUSES,
  INITIAL_STATUS,
  isTerminalStatus,
  TERMINAL_STATUSES,
} from './statuses.js'
import {
  availableTransitions,
  evaluateStatusChange,
  statusChangeSchema,
  TRANSITIONS,
  transitionsFrom,
} from './transitions.js'

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

  it('rechaza una transición que no existe', () => {
    const r = evaluateStatusChange({ from: 'NEW', to: 'DISBURSED', role: 'ADMIN' })
    expect(r).toEqual({ ok: false, reason: 'TRANSITION_NOT_ALLOWED' })
  })

  it('rechaza por rol insuficiente', () => {
    const r = evaluateStatusChange({ from: 'APPROVED', to: 'DISBURSED', role: 'AGENT' })
    expect(r).toEqual({ ok: false, reason: 'INSUFFICIENT_ROLE' })
  })

  it('exige motivo en los cierres y que sea válido para ese estado', () => {
    expect(evaluateStatusChange({ from: 'NEW', to: 'WITHDRAWN', role: 'AGENT' })).toEqual({
      ok: false,
      reason: 'REASON_REQUIRED',
    })
    expect(
      evaluateStatusChange({
        from: 'NEW',
        to: 'WITHDRAWN',
        role: 'AGENT',
        closeReason: 'INVALID_DOCUMENTS',
      }),
    ).toEqual({ ok: false, reason: 'REASON_NOT_VALID' })
    expect(
      evaluateStatusChange({
        from: 'NEW',
        to: 'WITHDRAWN',
        role: 'AGENT',
        closeReason: 'SPAM_OR_INVALID',
      }),
    ).toEqual({ ok: true, guard: null, requiresReason: true })
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

  it('rechaza estados desconocidos y versiones no enteras', () => {
    expect(statusChangeSchema.safeParse({ to: 'CLOSED', version: 1 }).success).toBe(false)
    expect(statusChangeSchema.safeParse({ to: 'CONTACTED', version: 1.5 }).success).toBe(false)
  })
})
