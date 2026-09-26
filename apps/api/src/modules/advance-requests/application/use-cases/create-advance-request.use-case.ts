import type { AdvanceRequestForm } from '@anticipate/shared/advance-request'
import { type IsoDate, LIMA_TIME_ZONE, todayIn } from '@anticipate/shared/dates'
import { createProblem, type Problem } from '@anticipate/shared/errors'
import { BusinessRulesViolatedError, ServiceUnavailableError } from '#/common/exceptions/index.js'
import type { FileStoragePort, StoredObject } from '#/common/storage/index.js'
import type { Clock } from '#/common/time/clock.js'
import { abortable } from '#/common/utils/abortable.js'
import type {
  AdvanceRequestRepositoryPort,
  CreateAdvanceRequestResult,
  ReservedFile,
} from '#/modules/advance-requests/application/ports/advance-request-repository.port.js'
import type { LegalDocumentReaderPort } from '#/modules/advance-requests/application/ports/legal-document-reader.port.js'
import type { PayerConditionsReaderPort } from '#/modules/advance-requests/application/ports/payer-conditions-reader.port.js'
import type { InvoiceIntakeService } from '#/modules/advance-requests/application/services/invoice-intake.service.js'
import type {
  CreateAdvanceRequestInput,
  CreateAdvanceRequestOutput,
  IdGenerator,
} from '#/modules/advance-requests/application/types/create-advance-request.types.js'
import { IdempotencyKeyReusedError } from '#/modules/advance-requests/domain/exceptions/idempotency-key-reused.error.js'
import { SubmissionDeadlineExceededError } from '#/modules/advance-requests/domain/exceptions/submission-deadline-exceeded.error.js'
import {
  buildAdvanceRequestCreatedEvent,
  toAdvanceRequestCreatedOutboxPayload,
} from '#/modules/advance-requests/domain/services/advance-request-created-event.js'
import {
  ADVANCE_REQUEST_OUTBOX_HANDLERS,
  advanceRequestOutboxDedupeKey,
} from '#/modules/advance-requests/domain/services/outbox-handlers.js'
import {
  computeRequestFingerprint,
  type FingerprintFile,
  sha256Hex,
} from '#/modules/advance-requests/domain/services/request-fingerprint.js'
import { storageKeys } from '#/modules/advance-requests/domain/services/storage-keys.js'
import type {
  IntakeInvoice,
  InvoiceIntakeResult,
  UploadedFile,
} from '#/modules/advance-requests/domain/types/invoice-intake.types.js'
import type {
  NewAdvanceRequest,
  NewInvoice,
} from '#/modules/advance-requests/domain/types/new-advance-request.js'
import type { PayerConditions } from '#/modules/advance-requests/domain/types/payer-conditions.js'
import type { NewOutboxMessage, OutboxWakeUpSignal } from '#/modules/outbox/index.js'

/**
 * Veces que se intenta guardar si otro envío se queda con una factura entre la verificación y el
 * INSERT y luego la libera. Pasado el tope, 503: un reintento del proveedor volvería a empezar.
 */
export const MAX_CREATE_ATTEMPTS = 3

const XML_CONTENT_TYPE = 'application/xml'
const PDF_CONTENT_TYPE = 'application/pdf'
/** Tope de `consents.user_agent` (VarChar(512)). */
const MAX_USER_AGENT_LENGTH = 512

export type CreateAdvanceRequestDependencies = {
  repository: AdvanceRequestRepositoryPort
  payerConditions: PayerConditionsReaderPort
  legalDocuments: LegalDocumentReaderPort
  invoiceIntake: InvoiceIntakeService
  storage: FileStoragePort
  outboxWakeUp: Pick<OutboxWakeUpSignal, 'notify'>
  clock: Clock
  newId: IdGenerator
  /** Prefijo de los códigos públicos (`PUBLIC_CODE_PREFIX`). */
  publicCodePrefix: string
  /** `SUBMISSION_TIMEOUT_MS`: plazo del envío, desde que empieza el caso de uso (D57). */
  submissionTimeoutMs: number
  /**
   * Tope de la limpieza de un intento que falló o venció (`SUBMISSION_CLEANUP_TIMEOUT_MS`): liberar sus
   * filas y borrar sus objetos. Lo que no alcance lo terminan la purga y el barrido de huérfanos.
   */
  cleanupTimeoutMs: number
}

/** Etapas del envío, para el diagnóstico de un plazo vencido. */
const STAGES = {
  idempotency: 'la búsqueda de la clave de idempotencia',
  conditions: 'el pagador y las versiones legales',
  intake: 'la lectura de los XML',
  availability: 'la búsqueda de las facturas tomadas',
  upload: 'la reserva y la subida de los archivos',
  save: 'la transacción (pudo confirmar: un reintento con la misma Idempotency-Key lo resuelve)',
} as const

type Stage = (typeof STAGES)[keyof typeof STAGES]

/** Una señal que se cancela con `reason()` a los `timeoutMs`; `clear()` apaga el temporizador. */
type Deadline = { readonly signal: AbortSignal; clear(): void }

function startDeadline(timeoutMs: number, reason: () => Error): Deadline {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(reason()), timeoutMs)
  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

/** La etapa en la que está el envío: el diagnóstico la nombra si vence el plazo. */
type Progress = { stage: Stage }

function assertPositiveMs(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} debe ser un entero positivo de milisegundos: ${value}`)
  }
}

type AcceptedIntake = Extract<InvoiceIntakeResult, { ok: true }>
type Digests = ReadonlyMap<UploadedFile, string>
/** Archivo listo para reservar y subir: la fila de `stored_files` más su contenido. */
type DraftFile = ReservedFile & { body: Buffer }
type Draft = { request: NewAdvanceRequest; files: readonly DraftFile[] }
type DraftContext = {
  input: CreateAdvanceRequestInput
  fingerprint: string
  payer: PayerConditions
  intake: AcceptedIntake
  now: Date
  today: IsoDate
  digests: Digests
}

/**
 * `POST /api/v1/advance-requests`. En orden: huella; clave de idempotencia (misma huella → misma
 * respuesta; otra → 422); condiciones del pagador; versiones legales; admisión de las facturas;
 * facturas ya tomadas (antes del 422 se relee la clave); reserva y subida de archivos (todo o nada);
 * una transacción con todo y el outbox; despertar al publicador. Nada queda subido sin su fila: lo
 * que se sube y no se guarda se libera y se borra (`discard`), y nunca se borra el objeto de un
 * archivo `ATTACHED`. Una lectura de la base que falla antes de subir nada no se captura aquí: el
 * traductor de errores de la base del filtro HTTP la responde como 503.
 *
 * Plazo (D57): todo el envío corre con `submissionTimeoutMs`. Cada dependencia recibe la señal del
 * plazo (lecturas, lector de XML, subida y transacción) y además se la espera con `abortable`: la
 * respuesta sale al vencer aunque una dependencia no atienda la señal. Al vencer, lo subido se libera
 * y se borra como en cualquier otra falla, con su propio tope (`cleanupTimeoutMs`), y la respuesta es
 * `SubmissionDeadlineExceededError` (503 con `Retry-After`). Si venció con el COMMIT en curso, la
 * transacción pudo confirmar: sus archivos quedan `ATTACHED` (la liberación nunca los toca) y el
 * reintento con la misma clave recibe la solicitud guardada. Así, la respuesta nunca tarda más que
 * `submissionTimeoutMs + cleanupTimeoutMs`.
 */
export class CreateAdvanceRequestUseCase {
  constructor(private readonly deps: CreateAdvanceRequestDependencies) {
    assertPositiveMs('submissionTimeoutMs', deps.submissionTimeoutMs)
    assertPositiveMs('cleanupTimeoutMs', deps.cleanupTimeoutMs)
  }

  async execute(input: CreateAdvanceRequestInput): Promise<CreateAdvanceRequestOutput> {
    const { submissionTimeoutMs } = this.deps
    const progress: Progress = { stage: STAGES.idempotency }
    const deadline = startDeadline(
      submissionTimeoutMs,
      () => new SubmissionDeadlineExceededError(submissionTimeoutMs, progress.stage),
    )
    try {
      return await this.submit(input, deadline.signal, progress)
    } finally {
      deadline.clear()
    }
  }

  private async submit(
    input: CreateAdvanceRequestInput,
    signal: AbortSignal,
    progress: Progress,
  ): Promise<CreateAdvanceRequestOutput> {
    const digests = digestFiles(input)
    const fingerprint = computeRequestFingerprint(input.form, fingerprintFiles(input, digests))

    const previous = await abortable(signal, () =>
      this.deps.repository.findByIdempotencyKey(input.idempotencyKey, { signal }),
    )
    if (previous !== null) return replay(previous, fingerprint, input.idempotencyKey)

    progress.stage = STAGES.conditions
    const payer = await this.findPayer(input.form, signal)
    await this.assertCurrentConsents(input.form, signal)

    progress.stage = STAGES.intake
    const now = this.deps.clock.now()
    const today = todayIn(LIMA_TIME_ZONE, now)
    const intake = await abortable(signal, () =>
      this.deps.invoiceIntake.evaluate(
        {
          payer,
          supplierRuc: input.form.company.ruc,
          today,
          requestedAmount: input.form.financing.requestedAmount,
          xmlFiles: input.xmlFiles,
          pdfFiles: input.pdfFiles,
        },
        { signal },
      ),
    )
    if (!intake.ok) throw new BusinessRulesViolatedError(intake.problems)

    const context: DraftContext = { input, fingerprint, payer, intake, now, today, digests }
    for (let attempt = 1; attempt <= MAX_CREATE_ATTEMPTS; attempt++) {
      progress.stage = STAGES.availability
      const replayed = await this.assertInvoicesAvailableOrReplay(context, signal)
      if (replayed !== null) return replayed
      // Ids y rutas nuevas en cada intento: las del intento anterior quedaron DELETED.
      const draft = this.buildDraft(context)
      progress.stage = STAGES.upload
      await this.upload(draft, signal)
      progress.stage = STAGES.save
      const result = await this.save(draft, payer, signal)
      if (result.kind === 'created') {
        this.deps.outboxWakeUp.notify()
        return { publicCode: result.publicCode, replayed: false }
      }
      await this.discard(draft.files)
      progress.stage = STAGES.availability
      if (result.kind === 'idempotency-conflict') {
        // Otro envío con la misma clave confirmó primero: se responde como un reintento.
        const winner = await abortable(signal, () =>
          this.deps.repository.findByIdempotencyKey(input.idempotencyKey, { signal }),
        )
        if (winner === null) {
          throw new ServiceUnavailableError('la clave chocó y la solicitud ganadora no aparece')
        }
        return replay(winner, fingerprint, input.idempotencyKey)
      }
      // `invoice-conflict`: el paso 6 se repite arriba y responde 422 si la factura sigue tomada.
    }
    const replayed = await this.assertInvoicesAvailableOrReplay(context, signal)
    if (replayed !== null) return replayed
    throw new ServiceUnavailableError(
      `las facturas chocaron ${MAX_CREATE_ATTEMPTS} veces con otros envíos`,
    )
  }

  private async findPayer(form: AdvanceRequestForm, signal: AbortSignal): Promise<PayerConditions> {
    const payer = await abortable(signal, () =>
      this.deps.payerConditions.findActiveBySlug(form.payerSlug, { signal }),
    )
    if (payer !== null) return payer
    throw new BusinessRulesViolatedError([
      createProblem('PAYER_NOT_AVAILABLE', {
        field: 'payerSlug',
        data: { payer: form.payerSlug },
      }),
    ])
  }

  private async assertCurrentConsents(
    form: AdvanceRequestForm,
    signal: AbortSignal,
  ): Promise<void> {
    const [termsCurrent, privacyCurrent] = await abortable(signal, () =>
      Promise.all([
        this.deps.legalDocuments.isCurrent('TERMS', form.consents.termsVersion, { signal }),
        this.deps.legalDocuments.isCurrent('PERSONAL_DATA', form.consents.privacyVersion, {
          signal,
        }),
      ]),
    )
    const problems: Problem[] = []
    if (!termsCurrent) {
      problems.push(createProblem('CONSENT_VERSION_OUTDATED', { field: 'consents.termsVersion' }))
    }
    if (!privacyCurrent) {
      problems.push(createProblem('CONSENT_VERSION_OUTDATED', { field: 'consents.privacyVersion' }))
    }
    if (problems.length > 0) throw new BusinessRulesViolatedError(problems)
  }

  /**
   * Paso 6: facturas en solicitudes abiertas. Devuelve `null` si están todas libres. Si alguna está
   * tomada, antes del 422 relee la clave: el envío original de este reintento pudo confirmar después
   * del paso 2, y entonces las facturas tomadas son las suyas. Se responde como si hubiera confirmado
   * antes del paso 2: la misma respuesta (misma huella) o 422 `IDEMPOTENCY_KEY_REUSED` (otra), nunca
   * un falso `INVOICE_ALREADY_IN_OPEN_REQUEST` (D45). Si la clave no aparece, 422 con un problema por
   * cada factura tomada.
   */
  private async assertInvoicesAvailableOrReplay(
    { input, fingerprint, intake: { invoices } }: DraftContext,
    signal: AbortSignal,
  ): Promise<CreateAdvanceRequestOutput | null> {
    const taken = new Set(
      await abortable(signal, () =>
        this.deps.repository.findInvoiceKeysInOpenRequests(
          invoices.map(({ key }) => key),
          { signal },
        ),
      ),
    )
    if (taken.size === 0) return null
    const previous = await abortable(signal, () =>
      this.deps.repository.findByIdempotencyKey(input.idempotencyKey, { signal }),
    )
    if (previous !== null) return replay(previous, fingerprint, input.idempotencyKey)
    throw new BusinessRulesViolatedError(
      invoices
        .filter(({ key }) => taken.has(key))
        .map(({ invoice, xml }) =>
          createProblem('INVOICE_ALREADY_IN_OPEN_REQUEST', {
            invoice: invoice.seriesNumber,
            file: xml.originalname,
            data: { invoice: invoice.seriesNumber },
          }),
        ),
    )
  }

  /**
   * Reserva las filas (`PENDING`) y sube los objetos, todo o nada. La reserva no se corta con el plazo
   * (un INSERT acotado por los tiempos de la base): si el plazo venció mientras tanto, se libera lo
   * reservado antes de subir nada.
   */
  private async upload(draft: Draft, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    try {
      await this.deps.repository.reserveFiles(draft.files.map(toReservedFile))
    } catch (error) {
      throw new ServiceUnavailableError('no se pudieron reservar los archivos', { cause: error })
    }
    if (signal.aborted) {
      await this.discard(draft.files)
      throw signal.reason
    }
    try {
      const inputs = draft.files.map(({ key, body, contentType }) => ({ key, body, contentType }))
      const stored = await abortable(signal, () => this.deps.storage.putAll(inputs, { signal }))
      assertStoredAsReserved(draft.files, stored)
    } catch (error) {
      await this.discard(draft.files)
      throw signal.aborted
        ? signal.reason
        : new ServiceUnavailableError('no se pudieron subir los archivos', { cause: error })
    }
  }

  private async save(
    draft: Draft,
    payer: PayerConditions,
    signal: AbortSignal,
  ): Promise<CreateAdvanceRequestResult> {
    try {
      return await abortable(signal, () =>
        this.deps.repository.create(
          draft.request,
          (publicCode) => this.outboxMessages(draft.request, payer, publicCode),
          { signal },
        ),
      )
    } catch (error) {
      await this.discard(draft.files)
      throw signal.aborted
        ? signal.reason
        : new ServiceUnavailableError('no se pudo guardar la solicitud', { cause: error })
    }
  }

  /**
   * Libera las filas que siguen `PENDING` y recién después borra sus objetos. Primero la base: si la
   * transacción llegó a confirmar aunque `create` lanzó (se cortó la conexión después del COMMIT, o
   * venció el plazo con el COMMIT en curso), sus filas están `ATTACHED`, no se liberan y sus objetos
   * no se tocan; el reintento del proveedor recibe la solicitud guardada. Con el COMMIT todavía en
   * curso, la liberación espera el candado de esas filas y ve el resultado. Nunca lanza y tarda como
   * mucho `cleanupTimeoutMs` (una señal propia: la del envío puede estar ya cancelada). Si la base no
   * responde, no se borra nada y las filas quedan `PENDING` para el barrido de huérfanos; un objeto que
   * no se pudo borrar tiene su fila `DELETED`, y lo borra la purga (Tarea 13).
   */
  private async discard(files: readonly DraftFile[]): Promise<void> {
    const { cleanupTimeoutMs } = this.deps
    const cleanup = startDeadline(
      cleanupTimeoutMs,
      () => new ServiceUnavailableError(`la limpieza no terminó en ${cleanupTimeoutMs} ms`),
    )
    const { signal } = cleanup
    try {
      const ids = files.map(({ id }) => id)
      const released = new Set(
        await abortable(signal, () => this.deps.repository.releaseFiles(ids, { signal })),
      )
      const keys = files.filter(({ id }) => released.has(id)).map(({ key }) => key)
      if (keys.length > 0) {
        await abortable(signal, () => this.deps.storage.deleteQuietly(keys, { signal }))
      }
    } catch {
      // El barrido de huérfanos y la purga (Tarea 13) terminan el trabajo.
    } finally {
      cleanup.clear()
    }
  }

  /** Una fila por handler, con el mismo evento: el payload solo lleva ids, tipo y versión. */
  private outboxMessages(
    request: NewAdvanceRequest,
    payer: PayerConditions,
    publicCode: string,
  ): NewOutboxMessage[] {
    const event = buildAdvanceRequestCreatedEvent({
      eventId: this.deps.newId(),
      occurredAt: request.createdAt,
      advanceRequestId: request.id,
      publicCode,
      payerSlug: payer.slug,
      supplierRuc: request.supplier.ruc,
      currency: request.currency,
      requestedAmount: request.requestedAmount,
      invoiceCount: request.invoices.length,
      contactEmail: request.contact.email,
    })
    const payload = toAdvanceRequestCreatedOutboxPayload(event)
    return Object.values(ADVANCE_REQUEST_OUTBOX_HANDLERS).map((handler) => ({
      handler,
      dedupeKey: advanceRequestOutboxDedupeKey(handler, event.id),
      eventType: event.type,
      payload,
      aggregate: { kind: 'ADVANCE_REQUEST', id: request.id },
      correlationId: request.correlationId,
    }))
  }

  private buildDraft({
    input,
    fingerprint,
    payer,
    intake,
    now,
    today,
    digests,
  }: DraftContext): Draft {
    const { form } = input
    const requestId = this.deps.newId()
    const files: DraftFile[] = []
    const draftFile = (
      upload: UploadedFile,
      key: string,
      purpose: ReservedFile['purpose'],
    ): DraftFile => {
      const file: DraftFile = {
        id: this.deps.newId(),
        bucket: this.deps.storage.bucket,
        key,
        purpose,
        contentType: purpose === 'INVOICE_XML' ? XML_CONTENT_TYPE : PDF_CONTENT_TYPE,
        sizeBytes: upload.buffer.length,
        sha256: digests.get(upload) ?? sha256Hex(upload.buffer),
        body: upload.buffer,
      }
      files.push(file)
      return file
    }

    const invoices = intake.invoices.map((accepted) => {
      const invoiceId = this.deps.newId()
      const xml = draftFile(
        accepted.xml,
        storageKeys.invoiceXml(payer.payerId, requestId, invoiceId),
        'INVOICE_XML',
      )
      const pdf =
        accepted.pdf === null
          ? null
          : draftFile(
              accepted.pdf,
              storageKeys.invoicePdf(payer.payerId, requestId, invoiceId),
              'INVOICE_PDF',
            )
      return toNewInvoice(invoiceId, accepted, xml.id, pdf?.id ?? null)
    })

    const { contact, company, financing, consents, source } = form
    const jobTitle = contact.jobTitle ?? null
    const userAgent = input.userAgent?.slice(0, MAX_USER_AGENT_LENGTH) || null
    const request: NewAdvanceRequest = {
      id: requestId,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint,
      payerId: payer.payerId,
      payerRuc: payer.ruc,
      supplier: { ruc: company.ruc, legalName: company.legalName },
      supplierLegalName: company.legalName,
      contact: {
        fullName: contact.fullName,
        dni: contact.dni,
        mobile: contact.mobile,
        email: contact.email,
        isLegalRepresentative: contact.isLegalRepresentative,
        jobTitle,
        contactTimeSlot: contact.contactTimeSlot,
      },
      legalRepresentative: contact.isLegalRepresentative
        ? { dni: contact.dni, fullName: contact.fullName, jobTitle }
        : null,
      requestedAmount: financing.requestedAmount,
      currency: intake.currency,
      // `purpose` admite texto vacío en el formulario; la base guarda NULL, nunca ''.
      purpose: financing.purpose || null,
      cavaliRegistration: form.cavaliRegistration,
      utm: source?.utm ?? null,
      referrer: source?.referrer ?? null,
      snapshot: {
        appliedAdvancePercent: payer.advancePercent,
        appliedMinTermDays: payer.minTermDays,
        totalNetPending: intake.totalNetPending,
        maxAmount: intake.maxAmount,
      },
      correlationId: input.correlationId,
      publicCodePrefix: this.deps.publicCodePrefix,
      publicCodeYear: Number(today.slice(0, 4)),
      fileIds: files.map(({ id }) => id),
      invoices,
      consents: [
        {
          type: 'TERMS',
          documentVersion: consents.termsVersion,
          ip: input.clientIp,
          userAgent,
          acceptedAt: now,
        },
        {
          type: 'PERSONAL_DATA',
          documentVersion: consents.privacyVersion,
          ip: input.clientIp,
          userAgent,
          acceptedAt: now,
        },
      ],
      createdAt: now,
    }
    return { request, files }
  }
}

/** La misma clave con la misma huella repite la respuesta; con otra, 422 con la clave en el log. */
function replay(
  previous: { publicCode: string; requestFingerprint: string },
  fingerprint: string,
  idempotencyKey: string,
): CreateAdvanceRequestOutput {
  if (previous.requestFingerprint !== fingerprint) {
    throw new IdempotencyKeyReusedError(idempotencyKey)
  }
  return { publicCode: previous.publicCode, replayed: true }
}

function digestFiles(input: CreateAdvanceRequestInput): Map<UploadedFile, string> {
  const digests = new Map<UploadedFile, string>()
  for (const file of [...input.xmlFiles, ...input.pdfFiles]) {
    digests.set(file, sha256Hex(file.buffer))
  }
  return digests
}

function fingerprintFiles(input: CreateAdvanceRequestInput, digests: Digests): FingerprintFile[] {
  const entry = (field: 'xml' | 'pdf', file: UploadedFile): FingerprintFile => ({
    field,
    originalname: file.originalname,
    sha256: digests.get(file) ?? sha256Hex(file.buffer),
  })
  return [
    ...input.xmlFiles.map((file) => entry('xml', file)),
    ...input.pdfFiles.map((file) => entry('pdf', file)),
  ]
}

function toReservedFile({ body: _body, ...reserved }: DraftFile): ReservedFile {
  return reserved
}

/** El almacenamiento devuelve lo que guardó en el mismo orden: tiene que ser lo reservado. */
function assertStoredAsReserved(files: readonly DraftFile[], stored: readonly StoredObject[]) {
  const same =
    stored.length === files.length &&
    files.every((file, index) => {
      const object = stored[index]
      return (
        object !== undefined &&
        object.key === file.key &&
        object.bucket === file.bucket &&
        object.sizeBytes === file.sizeBytes &&
        object.sha256 === file.sha256
      )
    })
  if (!same) throw new Error('El almacenamiento guardó algo distinto de lo reservado')
}

/** Factura aceptada → fila nueva: cuotas numeradas y vencimiento = el de la última cuota. */
function toNewInvoice(
  id: string,
  { invoice, key }: IntakeInvoice,
  xmlFileId: string,
  pdfFileId: string | null,
): NewInvoice {
  const installments = invoice.installments.map((installment, index) => ({
    number: index + 1,
    label: installment.id,
    amount: installment.amount,
    dueDate: installment.dueDate,
  }))
  const dueDate = installments
    .map((installment) => installment.dueDate)
    .sort()
    .at(-1)
  if (invoice.netPendingAmount === null || dueDate === undefined) {
    // Las reglas de shared exigen neto pendiente y cuotas: llegar aquí es un defecto del código.
    throw new TypeError(`La factura ${invoice.seriesNumber} pasó las reglas sin neto o sin cuotas`)
  }
  return {
    id,
    invoiceKey: key,
    documentType: invoice.documentType,
    seriesNumber: invoice.seriesNumber,
    issuerRuc: invoice.issuerRuc,
    issuerName: invoice.issuerName,
    recipientRuc: invoice.recipientRuc,
    total: invoice.total,
    netPendingAmount: invoice.netPendingAmount,
    issueDate: invoice.issueDate,
    dueDate,
    detraction: invoice.detraction,
    signed: invoice.signed,
    xmlFileId,
    pdfFileId,
    installments,
  }
}
