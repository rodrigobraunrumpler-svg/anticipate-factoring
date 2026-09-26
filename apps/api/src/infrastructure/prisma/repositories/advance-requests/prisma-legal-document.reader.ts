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
    const row = await this.prisma.legalDocumentVersion.findUnique({
      where: { type_version: { type, version } },
      select: { retiredAt: true },
    })
    return row !== null && row.retiredAt === null
  }
}
