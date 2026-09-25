import type { PaginationMeta } from '@anticipate/shared/api'

export type BuildPaginationMetaInput = {
  readonly totalCount: number
  readonly currentPage: number
  readonly perPage: number
}

function assertInteger(name: string, value: number, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new TypeError(`${name} debe ser un entero desde ${min}; llegó ${value}`)
  }
}

/**
 * Metadatos de una página de un catálogo acotado. Los valores ya vienen validados por el esquema de
 * la consulta: uno inválido aquí es un error de programación. Una página pedida más allá de la última
 * apunta hacia atrás a la última que existe.
 */
export function buildPaginationMeta({
  totalCount,
  currentPage,
  perPage,
}: BuildPaginationMetaInput): PaginationMeta {
  assertInteger('totalCount', totalCount, 0)
  assertInteger('currentPage', currentPage, 1)
  assertInteger('perPage', perPage, 1)
  const pageCount = Math.ceil(totalCount / perPage)
  return {
    totalCount,
    pageCount,
    currentPage,
    isFirstPage: currentPage === 1,
    isLastPage: currentPage >= pageCount,
    previousPage: currentPage > 1 ? Math.max(1, Math.min(currentPage - 1, pageCount)) : null,
    nextPage: currentPage < pageCount ? currentPage + 1 : null,
  }
}
