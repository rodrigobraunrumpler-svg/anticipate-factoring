/**
 * Mensajes entre `WorkerPool` y sus workers. Solo tipos: el script de un worker los importa con
 * `import type`, que se borra al quitar los tipos, así Node lo carga igual desde `src` (tests) que
 * desde `dist`.
 */

/** Del pool al worker: una tarea con su número. */
export type WorkerRequest<TInput> = { readonly id: number; readonly input: TInput }

/**
 * Del worker al pool: `ready` una sola vez, cuando terminó de cargar; después, por cada tarea, su
 * resultado o su falla (una excepción que el worker atrapó). Una excepción sin atrapar termina el
 * hilo y el pool la trata como defecto.
 */
export type WorkerReply<TOutput> =
  | { readonly kind: 'ready' }
  | { readonly kind: 'result'; readonly id: number; readonly value: TOutput }
  | { readonly kind: 'failure'; readonly id: number; readonly message: string }
