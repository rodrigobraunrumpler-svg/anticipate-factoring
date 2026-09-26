import { isXmlText } from '@anticipate/shared/text'
import { Logger } from '@nestjs/common'
import { abortable } from '#/common/utils/abortable.js'
import type { PrismaService } from '#/infrastructure/prisma/prisma.service.js'
import type {
  ConsentType,
  LegalDocumentReaderPort,
  RepositoryCallOptions,
} from '#/modules/advance-requests/index.js'

/** Largo máximo de la versión que se registra (el formulario ya la limita a 20). */
const LOGGED_VERSION_LENGTH = 20

/**
 * Versiones de los documentos legales (`legal_document_versions`, PK `(type, version)`). Una versión
 * vigente existe y no tiene `retired_at`, y puede haber más de una a la vez: la landing es estática y
 * envía la versión con la que se construyó. Por eso una versión nueva se carga antes de publicar la
 * landing que la envía, y la anterior se retira recién después (docs/STACK.md, sección 11). Un formulario
 * abierto con una versión retirada recibe `CONSENT_VERSION_OUTDATED` y, al recargar, la landing nueva.
 *
 * Cada versión que no está vigente queda en un log de error con su motivo (`retired` o `unknown`):
 * una o dos son formularios viejos; muchas seguidas son la landing y la base desacopladas, y ningún
 * envío entra hasta que se corrija. Con `signal` cancelada rechaza en el acto, sin registrar nada.
 */
export class PrismaLegalDocumentReader implements LegalDocumentReaderPort {
  private readonly logger = new Logger(PrismaLegalDocumentReader.name)

  constructor(private readonly prisma: PrismaService) {}

  isCurrent(
    type: ConsentType,
    version: string,
    options: RepositoryCallOptions = {},
  ): Promise<boolean> {
    return abortable(options.signal, () => this.check(type, version))
  }

  private async check(type: ConsentType, version: string): Promise<boolean> {
    // La versión llega del formulario. Un texto que la columna no puede guardar no está en ella, y
    // consultarlo no sirve: con U+0000 PostgreSQL rechaza el parámetro (22021, que Prisma lanza como
    // P2039: un 500 en vez de CONSENT_VERSION_OUTDATED) y un sustituto suelto viaja cambiado por
    // U+FFFD, así que podría coincidir con otra versión. `isXmlText` es la gemela del tipo de la
    // columna, la misma regla que ya aplica `advanceRequestFormSchema`.
    const row = isXmlText(version)
      ? await this.prisma.legalDocumentVersion.findUnique({
          where: { type_version: { type, version } },
          select: { retiredAt: true },
        })
      : null
    if (row !== null && row.retiredAt === null) return true
    this.logger.error(
      {
        type,
        version: version.slice(0, LOGGED_VERSION_LENGTH),
        status: row === null ? 'unknown' : 'retired',
      },
      'Una solicitud trae una versión legal que no está vigente y recibe 422 CONSENT_VERSION_OUTDATED. Si se repite, la landing publicada envía una versión que legal_document_versions no tiene vigente: carga la nueva o no retires la anterior hasta publicar la landing (docs/STACK.md, sección 11)',
    )
    return false
  }
}
