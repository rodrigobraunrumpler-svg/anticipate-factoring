import type { CursorMeta, PaginationMeta } from '@anticipate/shared/api'
import {
  type BuildPaginationMetaInput,
  buildPaginationMeta,
} from '#/common/utils/build-pagination-meta.js'

/**
 * Una página de un catálogo acotado (pagadores, usuarios), paginado por número de página.
 * `ResponseEnvelopeInterceptor` la publica como `data` + `metadataPagination`.
 */
export class PaginatedList<T> {
  readonly items: readonly T[]
  readonly meta: PaginationMeta

  constructor(items: readonly T[], meta: PaginationMeta) {
    this.items = Object.freeze([...items])
    this.meta = Object.freeze({ ...meta })
  }

  static of<T>(items: readonly T[], page: BuildPaginationMetaInput): PaginatedList<T> {
    return new PaginatedList(items, buildPaginationMeta(page))
  }
}

/**
 * Una página de una lista sin tope (bandeja, historial, auditoría, outbox), recorrida por cursor sobre
 * `id DESC`. `ResponseEnvelopeInterceptor` la publica como `data` + `metadataCursor`.
 */
export class CursorPaginatedList<T> {
  readonly items: readonly T[]
  readonly meta: CursorMeta

  constructor(items: readonly T[], meta: CursorMeta) {
    if (meta.hasNext !== (meta.nextCursor !== null)) {
      throw new TypeError('Hay página siguiente si y solo si hay cursor siguiente')
    }
    this.items = Object.freeze([...items])
    this.meta = Object.freeze({ ...meta })
  }

  /**
   * Arma la página con las filas leídas con `take: limit + 1`: si llegó una fila de más, hay página
   * siguiente, la fila sobrante no se devuelve y el cursor es el de la última fila devuelta.
   */
  static fromLookahead<T>(
    rows: readonly T[],
    limit: number,
    cursorOf: (item: T) => string,
  ): CursorPaginatedList<T> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new TypeError(`limit debe ser un entero desde 1; llegó ${limit}`)
    }
    const items = rows.slice(0, limit)
    const last = items.at(-1)
    const hasNext = rows.length > limit && last !== undefined
    return new CursorPaginatedList(items, {
      hasNext,
      nextCursor: hasNext && last !== undefined ? cursorOf(last) : null,
    })
  }
}
