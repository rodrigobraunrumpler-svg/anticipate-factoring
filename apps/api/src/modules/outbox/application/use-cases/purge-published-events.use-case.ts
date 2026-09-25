import type { OutboxEventRepositoryPort } from '../ports/outbox-event-repository.port.js'

export type PurgePublishedEventsOptions = { retentionDays: number; batchSize: number }

/** Borra los eventos `PUBLISHED` más viejos que la retención, en lotes, hasta que no quede ninguno. */
export class PurgePublishedEventsUseCase {
  constructor(
    private readonly repository: OutboxEventRepositoryPort,
    private readonly options: PurgePublishedEventsOptions,
  ) {}

  /** Devuelve cuántos eventos borró. */
  async execute(): Promise<number> {
    let deleted = 0
    let count: number
    do {
      count = await this.repository.purgePublished({
        olderThanDays: this.options.retentionDays,
        batchSize: this.options.batchSize,
      })
      deleted += count
    } while (count === this.options.batchSize)
    return deleted
  }
}
