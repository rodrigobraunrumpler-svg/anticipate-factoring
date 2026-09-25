import { describe, expect, it } from 'vitest'
import { buildPaginationMeta } from '#/common/utils/build-pagination-meta.js'
import { CursorPaginatedList, PaginatedList } from './paginated-list.js'

describe('buildPaginationMeta', () => {
  it.each([
    [
      { totalCount: 0, currentPage: 1, perPage: 20 },
      { pageCount: 0, isFirstPage: true, isLastPage: true, previousPage: null, nextPage: null },
    ],
    [
      { totalCount: 57, currentPage: 1, perPage: 20 },
      { pageCount: 3, isFirstPage: true, isLastPage: false, previousPage: null, nextPage: 2 },
    ],
    [
      { totalCount: 57, currentPage: 2, perPage: 20 },
      { pageCount: 3, isFirstPage: false, isLastPage: false, previousPage: 1, nextPage: 3 },
    ],
    [
      { totalCount: 57, currentPage: 3, perPage: 20 },
      { pageCount: 3, isFirstPage: false, isLastPage: true, previousPage: 2, nextPage: null },
    ],
    [
      { totalCount: 57, currentPage: 9, perPage: 20 },
      { pageCount: 3, isFirstPage: false, isLastPage: true, previousPage: 3, nextPage: null },
    ],
  ])('%o', (input, expected) => {
    expect(buildPaginationMeta(input)).toEqual({
      ...expected,
      totalCount: input.totalCount,
      currentPage: input.currentPage,
    })
  })

  it.each([
    { totalCount: -1, currentPage: 1, perPage: 20 },
    { totalCount: 1, currentPage: 0, perPage: 20 },
    { totalCount: 1, currentPage: 1, perPage: 0 },
    { totalCount: 1.5, currentPage: 1, perPage: 20 },
  ])('rechaza %o', (input) => {
    expect(() => buildPaginationMeta(input)).toThrow(TypeError)
  })
})

describe('PaginatedList', () => {
  it('guarda una copia congelada de la página y sus metadatos', () => {
    const items = [{ id: 'a' }]
    const page = PaginatedList.of(items, { totalCount: 1, currentPage: 1, perPage: 10 })
    items.push({ id: 'b' })
    expect(page.items).toEqual([{ id: 'a' }])
    expect(Object.isFrozen(page.items)).toBe(true)
    expect(page.meta.pageCount).toBe(1)
  })
})

describe('CursorPaginatedList.fromLookahead', () => {
  const rows = [{ id: '3' }, { id: '2' }, { id: '1' }]
  const cursorOf = (row: { id: string }) => row.id

  it('con una fila de más hay página siguiente y el cursor es la última fila devuelta', () => {
    const page = CursorPaginatedList.fromLookahead(rows, 2, cursorOf)
    expect(page.items).toEqual([{ id: '3' }, { id: '2' }])
    expect(page.meta).toEqual({ hasNext: true, nextCursor: '2' })
  })

  it('sin filas de más es la última página', () => {
    expect(CursorPaginatedList.fromLookahead(rows, 3, cursorOf).meta).toEqual({
      hasNext: false,
      nextCursor: null,
    })
    expect(CursorPaginatedList.fromLookahead([], 3, cursorOf).meta).toEqual({
      hasNext: false,
      nextCursor: null,
    })
  })

  it('rechaza un límite inválido y metadatos incoherentes', () => {
    expect(() => CursorPaginatedList.fromLookahead(rows, 0, cursorOf)).toThrow(TypeError)
    expect(() => new CursorPaginatedList(rows, { hasNext: true, nextCursor: null })).toThrow(
      TypeError,
    )
    expect(() => new CursorPaginatedList(rows, { hasNext: false, nextCursor: '1' })).toThrow(
      TypeError,
    )
  })
})
