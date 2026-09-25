import { describe, expect, it, vi } from 'vitest'
import type { OutboxEventRepositoryPort } from '../ports/outbox-event-repository.port.js'
import { PurgePublishedEventsUseCase } from './purge-published-events.use-case.js'

describe('PurgePublishedEventsUseCase', () => {
  it('borra en lotes hasta que un lote sale incompleto', async () => {
    const purgePublished = vi
      .fn<OutboxEventRepositoryPort['purgePublished']>()
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1)
    const repository = { purgePublished } as unknown as OutboxEventRepositoryPort
    const useCase = new PurgePublishedEventsUseCase(repository, { retentionDays: 30, batchSize: 2 })
    await expect(useCase.execute()).resolves.toBe(5)
    expect(purgePublished).toHaveBeenCalledTimes(3)
    expect(purgePublished).toHaveBeenCalledWith({ olderThanDays: 30, batchSize: 2 })
  })
})
