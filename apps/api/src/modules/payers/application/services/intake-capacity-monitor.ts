import {
  type IntakeCapacityShortfall,
  type IntakeLimits,
  intakeCapacityShortfalls,
} from '@anticipate/shared/api'
import type { PayerRepositoryPort } from '#/modules/payers/application/ports/payer-repository.port.js'
import type { Payer } from '#/modules/payers/domain/types/payer.js'

/** Variable de entorno de la API detrás de cada tope de `IntakeLimits` que puede quedarse corto. */
const VARIABLE_OF: Readonly<
  Record<IntakeCapacityShortfall['limit'], 'UPLOAD_MAX_FILES' | 'UPLOAD_MAX_BODY_BYTES'>
> = {
  maxFiles: 'UPLOAD_MAX_FILES',
  maxBodyBytes: 'UPLOAD_MAX_BODY_BYTES',
}

/** Un pagador activo cuya solicitud más grande no entra en los topes de subida de la API. */
export type IntakeCapacityConflict = {
  readonly payerId: string
  readonly slug: string
  readonly maxInvoices: number
  readonly variable: 'UPLOAD_MAX_FILES' | 'UPLOAD_MAX_BODY_BYTES'
  readonly current: number
  readonly required: number
}

/**
 * Lo que usa del logger de Nest (con nestjs-pino): contexto estructurado y mensaje. `error` pide que
 * alguien actúe (los logs de error alertan, STACK §12).
 */
export interface IntakeCapacityLogger {
  log(context: Record<string, unknown>, message: string): void
  warn(context: Record<string, unknown>, message: string): void
  error(context: Record<string, unknown>, message: string): void
}

function describeConflict(conflict: IntakeCapacityConflict): string {
  const { slug, maxInvoices, current, required } = conflict
  if (conflict.variable === 'UPLOAD_MAX_FILES') {
    return (
      `Topes de subida incoherentes con el pagador ${slug}: una solicitud de ${maxInvoices} ` +
      `facturas con su PDF son ${required} archivos y UPLOAD_MAX_FILES admite ${current}, así que ` +
      `el proveedor recibe 400 TOO_MANY_FILES. Sube UPLOAD_MAX_FILES a ${required} o baja ` +
      `max_invoices del pagador a ${Math.floor(current / 2)}.`
    )
  }
  return (
    `Topes de subida incoherentes con el pagador ${slug}: una solicitud de ${maxInvoices} ` +
    `facturas, con cada XML de hasta UPLOAD_MAX_XML_BYTES y su PDF, necesita un cuerpo de hasta ` +
    `${required} bytes y UPLOAD_MAX_BODY_BYTES admite ${current}, así que el proveedor recibe 413 ` +
    `PAYLOAD_TOO_LARGE. Sube UPLOAD_MAX_BODY_BYTES a ${required} (y UPLOAD_MAX_INFLIGHT_BYTES al ` +
    `menos a ese valor), baja UPLOAD_MAX_XML_BYTES o baja max_invoices del pagador.`
  )
}

/**
 * Revisa que los topes de subida de la API (`UPLOAD_MAX_FILES` y `UPLOAD_MAX_BODY_BYTES`) alcancen
 * para la solicitud más grande de cada pagador activo (`intakeCapacityShortfalls` de shared). El
 * máximo de facturas vive en la base y cambia sin desplegar; los topes, en la configuración. Si no
 * coinciden, una solicitud legítima recibe un 400 o un 413 en vez de la regla de negocio: por eso
 * cada conflicto deja un log de error con el pagador y la variable a cambiar. Corre al arrancar
 * (`reviewActivePayers`) y cada vez que se sirven los pagadores (`review`, desde la lista pública).
 * Cada conflicto se registra una vez por proceso: la lista pública se pide seguido.
 */
export class IntakeCapacityMonitor {
  private readonly limits: IntakeLimits
  private readonly reported = new Set<string>()

  constructor(
    limits: IntakeLimits,
    private readonly payers: PayerRepositoryPort,
    private readonly logger: IntakeCapacityLogger,
  ) {
    this.limits = {
      maxFiles: limits.maxFiles,
      maxXmlBytes: limits.maxXmlBytes,
      maxPdfBytes: limits.maxPdfBytes,
      maxBodyBytes: limits.maxBodyBytes,
    }
  }

  /**
   * Los conflictos de estos pagadores. Nunca lanza: corre al servir la lista pública. Un máximo que
   * no es un entero positivo no se juzga aquí (el mapeo público lo rechaza y lo registra).
   */
  review(payers: readonly Payer[]): IntakeCapacityConflict[] {
    const conflicts: IntakeCapacityConflict[] = []
    for (const payer of payers) {
      if (!Number.isSafeInteger(payer.maxInvoices) || payer.maxInvoices < 1) continue
      for (const shortfall of intakeCapacityShortfalls(payer.maxInvoices, this.limits)) {
        const conflict: IntakeCapacityConflict = {
          payerId: payer.id,
          slug: payer.slug,
          maxInvoices: payer.maxInvoices,
          variable: VARIABLE_OF[shortfall.limit],
          current: shortfall.current,
          required: shortfall.required,
        }
        conflicts.push(conflict)
        this.reportOnce(conflict)
      }
    }
    return conflicts
  }

  /**
   * Revisión del arranque. Nunca rechaza (`PayersModule` la lanza sin esperarla, y una promesa
   * rechazada sin manejar tumbaría el proceso): la API arranca aunque la base no responda (D47), y en
   * ese caso la revisión queda para la próxima vez que se sirva `GET /api/v1/payers`.
   */
  async reviewActivePayers(): Promise<void> {
    try {
      const payers = await this.payers.listActive()
      const conflicts = this.review(payers)
      this.logger.log(
        { activePayers: payers.length, conflicts: conflicts.length },
        'Topes de subida revisados contra el máximo de facturas de los pagadores activos',
      )
    } catch (error) {
      this.logger.warn(
        { err: error },
        'No se pudieron revisar los topes de subida contra los pagadores activos al arrancar; se revisan al servir GET /api/v1/payers',
      )
    }
  }

  private reportOnce(conflict: IntakeCapacityConflict): void {
    const key = `${conflict.payerId}|${conflict.maxInvoices}|${conflict.variable}`
    if (this.reported.has(key)) return
    this.reported.add(key)
    this.logger.error({ ...conflict }, describeConflict(conflict))
  }
}
