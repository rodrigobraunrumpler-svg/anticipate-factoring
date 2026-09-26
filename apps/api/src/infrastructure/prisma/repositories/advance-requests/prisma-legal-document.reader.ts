import { isXmlText } from '@anticipate/shared/text'
import type { PrismaService } from '#/infrastructure/prisma/prisma.service.js'
import type { ConsentType, LegalDocumentReaderPort } from '#/modules/advance-requests/index.js'

/**
 * Versiones de los documentos legales (`legal_document_versions`, PK `(type, version)`). Una versión
 * vigente existe y no tiene `retired_at`: al publicar una nueva, legal retira la anterior y los
 * formularios abiertos con la vieja reciben `CONSENT_VERSION_OUTDATED`.
 */
export class PrismaLegalDocumentReader implements LegalDocumentReaderPort {
  constructor(private readonly prisma: PrismaService) {}

  async isCurrent(type: ConsentType, version: string): Promise<boolean> {
    // La versión llega del formulario. Un texto que la columna no puede guardar no está en ella, y
    // consultarlo no sirve: con U+0000 PostgreSQL rechaza el parámetro (22021, que Prisma lanza como
    // P2039: un 500 en vez de CONSENT_VERSION_OUTDATED) y un sustituto suelto viaja cambiado por
    // U+FFFD, así que podría coincidir con otra versión. `isXmlText` es la gemela del tipo de la
    // columna, la misma regla que ya aplica `advanceRequestFormSchema`.
    if (!isXmlText(version)) return false
    const row = await this.prisma.legalDocumentVersion.findUnique({
      where: { type_version: { type, version } },
      select: { retiredAt: true },
    })
    return row !== null && row.retiredAt === null
  }
}
