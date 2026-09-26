import type { PrismaService } from '#/infrastructure/prisma/prisma.service.js'
import type {
  AdvanceRequestNotificationReaderPort,
  AdvanceRequestNotificationView,
} from '#/modules/advance-requests/index.js'
import {
  ADVANCE_REQUEST_NOTIFICATION_SELECT,
  toAdvanceRequestNotificationView,
} from './mappers/advance-request-notification-view.mapper.js'

/** Implementación Prisma de `AdvanceRequestNotificationReaderPort` (una lectura por la PK). */
export class PrismaAdvanceRequestNotificationReader
  implements AdvanceRequestNotificationReaderPort
{
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<AdvanceRequestNotificationView | null> {
    const row = await this.prisma.advanceRequest.findUnique({
      where: { id },
      select: ADVANCE_REQUEST_NOTIFICATION_SELECT,
    })
    return row === null ? null : toAdvanceRequestNotificationView(row)
  }
}
