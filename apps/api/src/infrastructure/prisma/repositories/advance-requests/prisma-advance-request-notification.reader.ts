import type { PrismaService } from '#/infrastructure/prisma/prisma.service.js'
import type {
  AdvanceRequestNotificationReaderPort,
  AdvanceRequestNotificationView,
  TeamAlertNotificationView,
} from '#/modules/advance-requests/index.js'
import {
  ADVANCE_REQUEST_NOTIFICATION_SELECT,
  TEAM_ALERT_NOTIFICATION_SELECT,
  toAdvanceRequestNotificationView,
  toTeamAlertNotificationView,
} from './mappers/advance-request-notification-view.mapper.js'

/** Implementación Prisma de `AdvanceRequestNotificationReaderPort` (cada vista, una lectura por la PK). */
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

  async findTeamAlertById(id: string): Promise<TeamAlertNotificationView | null> {
    const row = await this.prisma.advanceRequest.findUnique({
      where: { id },
      select: TEAM_ALERT_NOTIFICATION_SELECT,
    })
    return row === null ? null : toTeamAlertNotificationView(row)
  }
}
