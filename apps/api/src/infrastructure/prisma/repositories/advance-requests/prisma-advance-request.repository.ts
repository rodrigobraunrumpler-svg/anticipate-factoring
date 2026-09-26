import { formatPublicCode } from '@anticipate/shared/advance-request'
import { abortable } from '#/common/utils/abortable.js'
import { Prisma } from '#/infrastructure/prisma/generated/client.js'
import type { PrismaService } from '#/infrastructure/prisma/prisma.service.js'
import { isUniqueViolation } from '#/infrastructure/prisma/prisma-errors.js'
import { insertOutboxMessages } from '#/infrastructure/prisma/repositories/outbox/outbox-rows.js'
import type {
  AdvanceRequestRepositoryPort,
  CreateAdvanceRequestResult,
  NewAdvanceRequest,
  RepositoryCallOptions,
  ReservedFile,
} from '#/modules/advance-requests/index.js'
import type { NewOutboxMessage } from '#/modules/outbox/index.js'
import {
  toAdvanceRequestRow,
  toConsentRows,
  toInstallmentRows,
  toInvoiceRows,
  toStoredFileRows,
} from './mappers/new-advance-request-rows.mapper.js'

/** Índice único de la clave de idempotencia (`schema.prisma`). */
export const IDEMPOTENCY_KEY_INDEX = 'advance_requests_idempotency_key_key'
/** Índice único parcial de facturas en solicitudes abiertas (`schema.prisma`, reemplaza D26). */
export const OPEN_INVOICE_KEY_INDEX = 'invoices_open_invoice_key_key'

export type PrismaAdvanceRequestRepositoryOptions = {
  /** `DATABASE_TRANSACTION_TIMEOUT_MS`: menor que `idle_in_transaction_session_timeout`. */
  transactionTimeoutMs: number
  /** `DATABASE_TRANSACTION_MAX_WAIT_MS`. */
  transactionMaxWaitMs: number
  /** `OUTBOX_MAX_ATTEMPTS` de cada fila del outbox. */
  outboxMaxAttempts: number
}

/**
 * Claves de `keys` que ya están en una solicitud abierta. El predicado es el del índice parcial
 * `invoices_open_invoice_key_key`, escrito como literal: con el enum como parámetro (lo que hace el
 * query builder) PostgreSQL no usa el índice. Exportada para el test que lee el plan.
 */
export function openInvoiceKeysQuery(keys: readonly string[]): Prisma.Sql {
  return Prisma.sql`
    SELECT DISTINCT invoice_key
    FROM invoices
    WHERE invoice_key = ANY(${[...keys]}::text[])
      AND request_status <> ALL (ARRAY['REJECTED','WITHDRAWN']::advance_request_status[])`
}

/**
 * Implementación Prisma de `AdvanceRequestRepositoryPort`. Nunca `findUnique`, `upsert` ni `connect`
 * por `invoiceKey` (Prisma ignora el predicado del índice parcial), y proveedor y representante con
 * `createMany({ skipDuplicates })` + lectura: el `upsert` de Prisma 7.10 falla con P2002 ante envíos
 * simultáneos del mismo RUC nuevo.
 *
 * Cancelación (D57): Prisma no corta una consulta ya enviada, así que con `signal` cancelada cada
 * método rechaza en el acto (`abortable`) y la consulta en curso termina sola, acotada por los tiempos
 * de la base. La transacción de `create` además mira la señal antes de cada sentencia: cancelada antes
 * del COMMIT, se deshace en la siguiente; nunca se corta un COMMIT ya enviado.
 */
export class PrismaAdvanceRequestRepository implements AdvanceRequestRepositoryPort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly options: PrismaAdvanceRequestRepositoryOptions,
  ) {}

  findByIdempotencyKey(
    key: string,
    options: RepositoryCallOptions = {},
  ): Promise<{ publicCode: string; requestFingerprint: string } | null> {
    return abortable(options.signal, () =>
      this.prisma.advanceRequest.findUnique({
        where: { idempotencyKey: key },
        select: { publicCode: true, requestFingerprint: true },
      }),
    )
  }

  findInvoiceKeysInOpenRequests(
    keys: readonly string[],
    options: RepositoryCallOptions = {},
  ): Promise<string[]> {
    return abortable(options.signal, async () => {
      if (keys.length === 0) return []
      const rows = await this.prisma.$queryRaw<{ invoice_key: string }[]>(
        openInvoiceKeysQuery(keys),
      )
      return rows.map((row) => row.invoice_key)
    })
  }

  async reserveFiles(files: readonly ReservedFile[]): Promise<void> {
    if (files.length === 0) return
    // Una sola sentencia: todas las filas o ninguna.
    await this.prisma.storedFile.createMany({ data: toStoredFileRows(files) })
  }

  releaseFiles(fileIds: readonly string[], options: RepositoryCallOptions = {}): Promise<string[]> {
    return abortable(options.signal, async () => {
      if (fileIds.length === 0) return []
      // Solo lo que sigue PENDING, en la misma sentencia: un archivo ATTACHED (su transacción
      // confirmó) no cambia; si esa transacción todavía no terminó, la sentencia espera el candado de
      // la fila y ve el resultado. `purge_after = now()`: nunca estuvieron confirmados, no hay nada
      // que esperar. Se trunca al milisegundo, como en el barrido de huérfanos: timestamptz(3) redondea
      // y un valor redondeado hacia arriba no vencería en la consulta siguiente de la purga.
      const rows = await this.prisma.$queryRaw<{ id: string }[]>`
        UPDATE stored_files
        SET status = 'DELETED', deleted_at = now(), purge_after = date_trunc('milliseconds', now())
        WHERE id = ANY(${[...fileIds]}::uuid[]) AND status = 'PENDING'
        RETURNING id`
      return rows.map((row) => row.id)
    })
  }

  create(
    request: NewAdvanceRequest,
    outbox: (publicCode: string) => readonly NewOutboxMessage[],
    options: RepositoryCallOptions = {},
  ): Promise<CreateAdvanceRequestResult> {
    return abortable(options.signal, () => this.save(request, outbox, options.signal))
  }

  private async save(
    request: NewAdvanceRequest,
    outbox: (publicCode: string) => readonly NewOutboxMessage[],
    signal: AbortSignal | undefined,
  ): Promise<CreateAdvanceRequestResult> {
    // Antes de cada sentencia: con la señal cancelada, el callback lanza su motivo y Prisma deshace
    // la transacción. Después de la última no hay control: el COMMIT sigue su curso.
    const step = () => signal?.throwIfAborted()
    try {
      const publicCode = await this.prisma.$transaction(
        async (tx) => {
          step()
          const publicCode = await nextPublicCode(tx, request)
          step()
          const supplierId = await ensureSupplier(tx, request.supplier, step)
          const legalRepresentativeId =
            request.legalRepresentative === null
              ? null
              : await ensureLegalRepresentative(tx, supplierId, request.legalRepresentative, step)
          step()
          await tx.advanceRequest.create({
            data: toAdvanceRequestRow(request, { publicCode, supplierId, legalRepresentativeId }),
            select: { id: true },
          })
          step()
          await attachFiles(tx, request.fileIds)
          step()
          await tx.invoice.createMany({ data: toInvoiceRows(request) })
          step()
          await tx.invoiceInstallment.createMany({ data: toInstallmentRows(request) })
          step()
          await tx.consent.createMany({ data: toConsentRows(request) })
          step()
          await tx.statusHistory.create({
            data: {
              advanceRequestId: request.id,
              fromStatus: null,
              toStatus: 'NEW',
              version: 1,
              correlationId: request.correlationId,
            },
            select: { id: true },
          })
          step()
          await insertOutboxMessages(tx, outbox(publicCode), {
            maxAttempts: this.options.outboxMaxAttempts,
          })
          step()
          return publicCode
        },
        {
          timeout: this.options.transactionTimeoutMs,
          maxWait: this.options.transactionMaxWaitMs,
        },
      )
      return { kind: 'created', publicCode }
    } catch (error) {
      // El nombre del índice llega en meta.driverAdapterError.cause.constraint.index (no en
      // meta.target); isUniqueViolation lo compara exacto.
      if (isUniqueViolation(error, IDEMPOTENCY_KEY_INDEX)) return { kind: 'idempotency-conflict' }
      if (isUniqueViolation(error, OPEN_INVOICE_KEY_INDEX)) {
        return {
          kind: 'invoice-conflict',
          invoiceKeys: request.invoices.map(({ invoiceKey }) => invoiceKey),
        }
      }
      throw error
    }
  }
}

async function nextPublicCode(
  tx: Prisma.TransactionClient,
  request: NewAdvanceRequest,
): Promise<string> {
  const [row] = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT nextval('advance_request_code_seq') AS n`
  if (row === undefined) throw new Error('advance_request_code_seq no devolvió valor')
  return formatPublicCode({
    prefix: request.publicCodePrefix,
    year: request.publicCodeYear,
    sequence: Number(row.n),
  })
}

/** ON CONFLICT DO NOTHING y lectura: lo guardado (y lo que corrigió el admin) no se pisa. */
async function ensureSupplier(
  tx: Prisma.TransactionClient,
  supplier: NewAdvanceRequest['supplier'],
  step: () => void,
): Promise<string> {
  await tx.supplier.createMany({
    data: [{ ruc: supplier.ruc, legalName: supplier.legalName }],
    skipDuplicates: true,
  })
  step()
  const { id } = await tx.supplier.findUniqueOrThrow({
    where: { ruc: supplier.ruc },
    select: { id: true },
  })
  return id
}

async function ensureLegalRepresentative(
  tx: Prisma.TransactionClient,
  supplierId: string,
  representative: NonNullable<NewAdvanceRequest['legalRepresentative']>,
  step: () => void,
): Promise<string> {
  await tx.legalRepresentative.createMany({
    data: [
      {
        supplierId,
        dni: representative.dni,
        fullName: representative.fullName,
        jobTitle: representative.jobTitle,
      },
    ],
    skipDuplicates: true,
  })
  step()
  const { id } = await tx.legalRepresentative.findUniqueOrThrow({
    where: { supplierId_dni: { supplierId, dni: representative.dni } },
    select: { id: true },
  })
  return id
}

/** Los archivos reservados pasan a `ATTACHED`; si alguno ya no está `PENDING`, todo se deshace. */
async function attachFiles(tx: Prisma.TransactionClient, fileIds: readonly string[]) {
  const attached = await tx.$executeRaw`
    UPDATE stored_files
    SET status = 'ATTACHED', attached_at = now()
    WHERE id = ANY(${[...fileIds]}::uuid[]) AND status = 'PENDING'`
  if (attached !== fileIds.length) {
    throw new Error(`Solo ${attached} de ${fileIds.length} archivos reservados seguían PENDING`)
  }
}
