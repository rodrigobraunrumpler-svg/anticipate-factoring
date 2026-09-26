import type { NewAdvanceRequest } from '#/modules/advance-requests/domain/types/new-advance-request.js'
import type { NewOutboxMessage } from '#/modules/outbox/index.js'

/** Fila de `stored_files` que se reserva en `PENDING` antes de subir su objeto. */
export type ReservedFile = {
  id: string
  bucket: string
  key: string
  purpose: 'INVOICE_XML' | 'INVOICE_PDF'
  contentType: string
  sizeBytes: number
  sha256: string
}

/**
 * Resultado de `create`. Los dos choques de unicidad son resultados, no excepciones: el caso de uso
 * decide qué hacer con cada uno. `invoiceKeys` son las claves de la solicitud que chocó (candidatas):
 * el caso de uso confirma cuáles siguen tomadas con `findInvoiceKeysInOpenRequests`.
 */
export type CreateAdvanceRequestResult =
  | { kind: 'created'; publicCode: string }
  | { kind: 'invoice-conflict'; invoiceKeys: string[] }
  | { kind: 'idempotency-conflict' }

/**
 * Cancelación de quien llama (el plazo del envío, D57). Con `signal` cancelada, la operación rechaza en
 * el acto con su motivo, sin esperar a la base. Lo que ya se mandó puede terminar igual: una lectura
 * se descarta; una escritura puede quedar hecha (cada método dice qué pasa).
 */
export type RepositoryCallOptions = { readonly signal?: AbortSignal | undefined }

export interface AdvanceRequestRepositoryPort {
  findByIdempotencyKey(
    key: string,
    options?: RepositoryCallOptions,
  ): Promise<{ publicCode: string; requestFingerprint: string } | null>
  /** Claves que ya están en una solicitud abierta (ni `REJECTED` ni `WITHDRAWN`). */
  findInvoiceKeysInOpenRequests(
    keys: readonly string[],
    options?: RepositoryCallOptions,
  ): Promise<string[]>
  /**
   * Transacción corta: inserta las filas de stored_files en PENDING antes de subir los objetos. No se
   * cancela: si quien llama dejara de esperarla, las filas podrían aparecer después de liberarlas.
   */
  reserveFiles(files: readonly ReservedFile[]): Promise<void>
  /**
   * Libera archivos reservados: pasa a DELETED (con purge_after = now()) los que siguen PENDING, en
   * una sola sentencia, y devuelve sus ids. Uno que ya está ATTACHED (su transacción confirmó) no
   * cambia y no se devuelve. Una fila DELETED nunca vuelve a PENDING ni pasa a ATTACHED, así que
   * borrar los objetos de lo devuelto nunca toca un archivo de una solicitud guardada. Cancelada, la
   * sentencia ya enviada puede liberar igual: sus objetos los borra la purga.
   */
  releaseFiles(fileIds: readonly string[], options?: RepositoryCallOptions): Promise<string[]>
  /**
   * Una transacción: código público, proveedor y representante (INSERT con ON CONFLICT DO NOTHING
   * más lectura), solicitud, archivos a ATTACHED, facturas, cuotas, consentimientos, historial
   * inicial y outbox. Con `signal` cancelada antes del COMMIT, la transacción se deshace en la
   * siguiente sentencia; si el COMMIT ya salió, puede confirmar aunque la llamada haya rechazado. En
   * los dos casos los archivos siguen la regla de `releaseFiles`: nunca se libera uno ATTACHED.
   */
  create(
    request: NewAdvanceRequest,
    outbox: (publicCode: string) => readonly NewOutboxMessage[],
    options?: RepositoryCallOptions,
  ): Promise<CreateAdvanceRequestResult>
}

export const ADVANCE_REQUEST_REPOSITORY = Symbol('ADVANCE_REQUEST_REPOSITORY')
