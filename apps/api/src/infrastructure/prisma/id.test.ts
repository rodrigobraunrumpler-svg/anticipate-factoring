import { describe, expect, it } from 'vitest'
import { newId } from './id.js'

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('newId', () => {
  it('genera UUIDv7 en minúsculas con la variante de RFC 9562', () => {
    for (let i = 0; i < 100; i++) expect(newId()).toMatch(UUID_V7)
  })

  it('lleva en los primeros 48 bits el milisegundo de creación', () => {
    const before = Date.now()
    const id = newId()
    const after = Date.now()
    const createdAt = Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16)
    expect(createdAt).toBeGreaterThanOrEqual(before)
    expect(createdAt).toBeLessThanOrEqual(after)
  })

  it('ordena como texto en el orden de creación, también dentro del mismo milisegundo', () => {
    const ids = Array.from({ length: 5000 }, () => newId())
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.toSorted()).toEqual(ids)
  })
})
