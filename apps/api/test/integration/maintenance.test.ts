import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import type { NestExpressApplication } from '@nestjs/platform-express'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FILE_STORAGE, type FileStoragePort } from '#/common/storage/index.js'
import { PrismaService } from '#/infrastructure/prisma/prisma.service.js'
import { outboxLateAfterSeconds } from '#/infrastructure/prisma/repositories/maintenance/outbox-backlog-readiness.indicator.js'
import {
  STORED_FILE_MAINTENANCE,
  type StoredFileMaintenancePort,
} from '#/modules/maintenance/index.js'
import {
  MAINTENANCE_TASKS,
  MaintenanceScheduler,
  type MaintenanceTask,
} from '#/workers/maintenance/maintenance.scheduler.js'
import { MAINTENANCE_TASK_NAMES } from '#/workers/maintenance/maintenance-worker.module.js'
import { createTestApp } from '../support/app.js'
import { testConfig } from '../support/config.js'
import { createTestPrisma, truncateAll } from '../support/db.js'
import { createCompleteAdvanceRequest } from '../support/factories.js'

const db = createTestPrisma()
const { prisma } = db
const config = testConfig()
const MINUTES_PER_DAY = 24 * 60
const BODY = Buffer.from('<Invoice/>')
const BODY_SHA256 = createHash('sha256').update(BODY).digest('hex')
const prefix = `tests/maintenance/${randomUUID()}/`
const uploadedKeys: string[] = []
const ALL_TASKS = Object.values(MAINTENANCE_TASK_NAMES)

let app: NestExpressApplication
let storage: FileStoragePort
let scheduler: MaintenanceScheduler
let files: StoredFileMaintenancePort

beforeAll(async () => {
  app = await createTestApp()
  storage = app.get<FileStoragePort>(FILE_STORAGE)
  scheduler = app.get(MaintenanceScheduler)
  files = app.get<StoredFileMaintenancePort>(STORED_FILE_MAINTENANCE)
})

beforeEach(async () => {
  await truncateAll(prisma)
})

afterAll(async () => {
  await storage.deleteQuietly(uploadedKeys)
  // El último test deja un evento DEAD_LETTER: sin esto, la readiness de otros archivos sale `degraded`.
  await truncateAll(prisma)
  await app.close()
  await db.close()
})

/** Sube un objeto a S3Mock con el adaptador real y devuelve su clave. */
async function upload(name: string): Promise<string> {
  const key = `${prefix}${name}`
  await storage.putAll([{ key, body: BODY, contentType: 'application/xml' }])
  uploadedKeys.push(key)
  return key
}

type FileSeed = {
  key: string
  status: 'PENDING' | 'ATTACHED' | 'DELETED'
  createdMinutesAgo: number
  attachedMinutesAgo?: number
  deletedMinutesAgo?: number
  /** Minutos desde ahora hasta `purge_after`; negativo si ya venció. */
  purgeAfterInMinutes?: number
  bucket?: string
}

/**
 * Inserta una fila de `stored_files` con SQL: es la única forma de tener un archivo "viejo" sin
 * esperar, porque `created_at` es inmutable (`stored_files_guard`) y lo pone la base.
 */
async function seedFile(seed: FileSeed): Promise<string> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO stored_files
      (storage_bucket, key, purpose, content_type, size_bytes, sha256, status,
       attached_at, deleted_at, purge_after, created_at)
    VALUES
      (${seed.bucket ?? storage.bucket}, ${seed.key}, 'INVOICE_XML', 'application/xml',
       ${BODY.length}::int, ${BODY_SHA256}, ${seed.status},
       now() - make_interval(mins => ${seed.attachedMinutesAgo ?? null}::int),
       now() - make_interval(mins => ${seed.deletedMinutesAgo ?? null}::int),
       now() + make_interval(mins => ${seed.purgeAfterInMinutes ?? null}::int),
       now() - make_interval(mins => ${seed.createdMinutesAgo}::int))
    RETURNING id`
  const id = rows[0]?.id
  if (id === undefined) throw new Error('No se insertó el archivo de prueba.')
  return id
}

type FileState = {
  status: string
  deletedAt: Date | null
  purgedAt: Date | null
  /** Días entre `deleted_at` y `purge_after`, redondeados. */
  delayDays: number | null
}

async function fileState(id: string): Promise<FileState> {
  const rows = await prisma.$queryRaw<FileState[]>`
    SELECT status::text AS status,
           deleted_at AS "deletedAt",
           purged_at AS "purgedAt",
           round(extract(epoch FROM purge_after - deleted_at) / 86400)::int AS "delayDays"
      FROM stored_files
     WHERE id = ${id}::uuid`
  const state = rows[0]
  if (state === undefined) throw new Error(`No existe el archivo ${id}.`)
  return state
}

type OutboxSeed = {
  advanceRequestId: string
  status: 'PENDING' | 'PUBLISHED' | 'DEAD_LETTER'
  /** Antigüedad del evento: su id es un UUIDv7 de ese momento, como si se hubiera creado entonces. */
  ageHours: number
}

/** Inserta un evento del outbox con SQL; `uuidv7(desplazamiento)` de PostgreSQL 18 fecha su id. */
async function seedOutboxEvent(seed: OutboxSeed): Promise<string> {
  const eventType = 'advance-request.created'
  const payload = JSON.stringify({
    id: randomUUID(),
    type: eventType,
    version: 1,
    occurredAt: new Date().toISOString(),
    aggregateId: seed.advanceRequestId,
  })
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO outbox_events
      (id, handler, dedupe_key, event_type, payload, advance_request_id, status, attempts,
       max_attempts, available_at, published_at, last_error, created_at, updated_at)
    VALUES
      (uuidv7(make_interval(hours => ${-seed.ageHours}::int)), 'email.team-alert',
       ${`test:${randomUUID()}`}, ${eventType}, ${payload}::jsonb, ${seed.advanceRequestId}::uuid,
       ${seed.status}, 1, 8,
       now() - make_interval(hours => ${seed.ageHours}::int),
       CASE WHEN ${seed.status === 'PUBLISHED'} THEN now() - make_interval(hours => ${seed.ageHours}::int) END,
       CASE WHEN ${seed.status === 'DEAD_LETTER'} THEN 'EMAIL_PERMANENT' END,
       now() - make_interval(hours => ${seed.ageHours}::int),
       now() - make_interval(hours => ${seed.ageHours}::int))
    RETURNING id`
  const id = rows[0]?.id
  if (id === undefined) throw new Error('No se insertó el evento de prueba.')
  return id
}

async function remainingOutboxIds(ids: readonly string[]): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM outbox_events WHERE id = ANY(${ids}::uuid[]) ORDER BY id`
  return rows.map((row) => row.id)
}

/** Promesa que el test resuelve cuando quiere. */
function deferred() {
  let settle: () => void = () => undefined
  const promise = new Promise<void>((resolve) => {
    settle = resolve
  })
  return { promise, resolve: () => settle() }
}

describe('barrido de archivos huérfanos', () => {
  it('da de baja el PENDING más viejo que la gracia y la misma pasada borra su objeto', async () => {
    const graceMinutes = config.storage.orphanGraceMinutes
    const orphanKey = await upload('huerfano.xml')
    const recentKey = await upload('reciente.xml')
    const attachedKey = await upload('adjunto.xml')
    const orphan = await seedFile({
      key: orphanKey,
      status: 'PENDING',
      createdMinutesAgo: graceMinutes + 60,
    })
    const recent = await seedFile({ key: recentKey, status: 'PENDING', createdMinutesAgo: 5 })
    const attached = await seedFile({
      key: attachedKey,
      status: 'ATTACHED',
      createdMinutesAgo: graceMinutes + 60,
      attachedMinutesAgo: graceMinutes + 59,
    })

    await expect(scheduler.runOnce()).resolves.toEqual({
      completed: ALL_TASKS,
      failed: [],
      skipped: [],
    })

    const swept = await fileState(orphan)
    expect(swept).toMatchObject({ status: 'DELETED', delayDays: 0 })
    expect(swept.purgedAt).toBeInstanceOf(Date)
    expect(await storage.exists(orphanKey)).toBe(false)
    expect(await fileState(recent)).toMatchObject({ status: 'PENDING', deletedAt: null })
    expect(await storage.exists(recentKey)).toBe(true)
    expect(await fileState(attached)).toMatchObject({ status: 'ATTACHED', deletedAt: null })
    expect(await storage.exists(attachedKey)).toBe(true)
  })

  it('markDeleted no da de baja un archivo que ya no está en el estado esperado', async () => {
    const id = await seedFile({
      key: `${prefix}confirmado.xml`,
      status: 'ATTACHED',
      createdMinutesAgo: 600,
      attachedMinutesAgo: 590,
    })

    await expect(
      files.markDeleted({ ids: [id], expectedStatus: 'PENDING', purgeAfterDays: 0 }),
    ).resolves.toEqual([])
    expect(await fileState(id)).toMatchObject({ status: 'ATTACHED', deletedAt: null })
  })
})

describe('borrado diferido', () => {
  it('un archivo ATTACHED que pasa a DELETED espera STORAGE_DELETE_DELAY_DAYS y su objeto sigue en el bucket', async () => {
    const key = await upload('reemplazado.xml')
    const id = await seedFile({
      key,
      status: 'ATTACHED',
      createdMinutesAgo: 600,
      attachedMinutesAgo: 590,
    })

    await expect(
      files.markDeleted({
        ids: [id],
        expectedStatus: 'ATTACHED',
        purgeAfterDays: config.storage.deleteDelayDays,
      }),
    ).resolves.toEqual([id])
    await scheduler.runOnce()

    expect(await fileState(id)).toMatchObject({
      status: 'DELETED',
      delayDays: config.storage.deleteDelayDays,
      purgedAt: null,
    })
    expect(await storage.exists(key)).toBe(true)
  })

  it('borra el objeto cuando vence purge_after y deja constancia en purged_at', async () => {
    const key = await upload('vencido.xml')
    const id = await seedFile({
      key,
      status: 'DELETED',
      createdMinutesAgo: 40 * MINUTES_PER_DAY,
      attachedMinutesAgo: 40 * MINUTES_PER_DAY,
      deletedMinutesAgo: 36 * MINUTES_PER_DAY,
      purgeAfterInMinutes: -MINUTES_PER_DAY,
    })

    await scheduler.runOnce()

    const state = await fileState(id)
    expect(state.status).toBe('DELETED')
    expect(state.purgedAt).toBeInstanceOf(Date)
    expect(await storage.exists(key)).toBe(false)
  })

  it('no marca como purgado un archivo de otro bucket', async () => {
    const id = await seedFile({
      key: `${prefix}otro-bucket.xml`,
      bucket: 'anticipate-otro-bucket',
      status: 'DELETED',
      createdMinutesAgo: 600,
      deletedMinutesAgo: 600,
      purgeAfterInMinutes: -60,
    })

    await scheduler.runOnce()

    expect(await fileState(id)).toMatchObject({ status: 'DELETED', purgedAt: null })
  })
})

describe('purga del outbox', () => {
  const retentionHours = config.outbox.retentionDays * 24

  it('borra por rango de PK los PUBLISHED más viejos que la retención y deja el resto', async () => {
    const { id: advanceRequestId } = await createCompleteAdvanceRequest(prisma, {})
    const expired = await seedOutboxEvent({
      advanceRequestId,
      status: 'PUBLISHED',
      ageHours: retentionHours + 1,
    })
    const recent = await seedOutboxEvent({
      advanceRequestId,
      status: 'PUBLISHED',
      ageHours: retentionHours - 1,
    })
    const deadLetter = await seedOutboxEvent({
      advanceRequestId,
      status: 'DEAD_LETTER',
      ageHours: retentionHours + 240,
    })
    const pending = await seedOutboxEvent({
      advanceRequestId,
      status: 'PENDING',
      ageHours: retentionHours + 240,
    })

    await expect(scheduler.runOnce()).resolves.toMatchObject({ failed: [] })

    expect(await remainingOutboxIds([expired, recent, deadLetter, pending])).toEqual(
      [recent, deadLetter, pending].sort(),
    )
  })

  it('purga en lotes hasta vaciar', async () => {
    const small = await createTestApp({ env: { OUTBOX_PURGE_BATCH_SIZE: '2' } })
    try {
      const { id: advanceRequestId } = await createCompleteAdvanceRequest(prisma, {})
      const expired: string[] = []
      for (let index = 0; index < 5; index += 1) {
        expired.push(
          await seedOutboxEvent({
            advanceRequestId,
            status: 'PUBLISHED',
            ageHours: retentionHours + 1 + index,
          }),
        )
      }
      const recent = await seedOutboxEvent({ advanceRequestId, status: 'PUBLISHED', ageHours: 1 })

      await expect(small.get(MaintenanceScheduler).runOnce()).resolves.toMatchObject({
        failed: [],
      })

      expect(await remainingOutboxIds([...expired, recent])).toEqual([recent])
    } finally {
      await small.close()
    }
  })
})

describe('programador de mantenimiento', () => {
  it('con MAINTENANCE_ENABLED=false no corre ninguna pasada por su cuenta', async () => {
    const runs: string[] = []
    const task: MaintenanceTask = {
      name: 'registro',
      async run() {
        runs.push('registro')
      },
    }
    const disabled = await createTestApp({ overrides: [[MAINTENANCE_TASKS, [task]]] })
    try {
      await sleep(300)
      expect(runs).toEqual([])

      // El programador está cargado y una pasada a mano corre: solo la programación está apagada.
      await expect(disabled.get(MaintenanceScheduler).runOnce()).resolves.toEqual({
        completed: ['registro'],
        failed: [],
        skipped: [],
      })
    } finally {
      await disabled.close()
    }
  })

  it('al cerrar la app espera la pasada en curso, no empieza tareas nuevas y la base sigue abierta hasta el final', async () => {
    const events: string[] = []
    const started = deferred()
    const release = deferred()
    let enabled: NestExpressApplication | undefined
    const tasks: MaintenanceTask[] = [
      {
        name: 'en-curso',
        async run() {
          events.push('en-curso:inicio')
          started.resolve()
          await release.promise
          if (enabled === undefined) throw new Error('La app de prueba no terminó de arrancar.')
          // Si el pool ya estuviera cerrado, esta consulta fallaría y la tarea saldría en `failed`.
          await enabled.get(PrismaService).$queryRaw`SELECT 1`
          events.push('en-curso:fin')
        },
      },
      {
        name: 'siguiente',
        async run() {
          events.push('siguiente')
        },
      },
    ]
    enabled = await createTestApp({
      env: { MAINTENANCE_ENABLED: 'true' },
      overrides: [[MAINTENANCE_TASKS, tasks]],
    })

    // La primera pasada arranca sola al terminar el bootstrap.
    await started.promise
    const pass = enabled.get(MaintenanceScheduler).runOnce()
    const closing = enabled.close().then(() => {
      events.push('app:cerrada')
    })

    await sleep(300)
    expect(events).toEqual(['en-curso:inicio'])

    release.resolve()
    await closing
    expect(events).toEqual(['en-curso:inicio', 'en-curso:fin', 'app:cerrada'])
    await expect(pass).resolves.toEqual({
      completed: ['en-curso'],
      failed: [],
      skipped: ['siguiente'],
    })
  })
})

describe('readiness con el backlog del outbox', () => {
  const lateAfterSeconds = outboxLateAfterSeconds(config.outbox)

  // Una app por test: el indicador guarda su resultado unos segundos y otro test lo reutilizaría.
  it('sin eventos fallidos ni atrasados responde ok con el outbox up', async () => {
    const probe = await createTestApp()
    try {
      const response = await request(probe.getHttpServer()).get('/health/readiness')

      expect(response.status).toBe(200)
      expect(response.body.status).toBe('ok')
      expect(response.body.details.outbox).toMatchObject({
        status: 'up',
        deadLetter: 0,
        late: 0,
        lateAfterSeconds,
      })
    } finally {
      await probe.close()
    }
  })

  it('con un evento en DEAD_LETTER responde 200 degraded y la réplica sigue en rotación', async () => {
    const { id: advanceRequestId } = await createCompleteAdvanceRequest(prisma, {})
    await seedOutboxEvent({ advanceRequestId, status: 'DEAD_LETTER', ageHours: 1 })
    const probe = await createTestApp()
    try {
      const response = await request(probe.getHttpServer()).get('/health/readiness')

      expect(response.status).toBe(200)
      expect(response.body.status).toBe('degraded')
      expect(response.body.error).toEqual({})
      expect(response.body.details.outbox).toMatchObject({
        status: 'degraded',
        deadLetter: 1,
        lateAfterSeconds,
      })
    } finally {
      await probe.close()
    }
  })
})
