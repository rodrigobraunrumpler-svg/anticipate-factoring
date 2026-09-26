import { randomUUID } from 'node:crypto'
import type { AdvanceRequestForm } from '@anticipate/shared/advance-request'
import { buildInvoiceXml, type TestXmlOptions } from '@anticipate/shared/testing'
import type { NestExpressApplication } from '@nestjs/platform-express'
import request from 'supertest'
import {
  CAPTCHA_TOKEN_HEADER,
  CORRELATION_ID_HEADER,
  IDEMPOTENCY_KEY_HEADER,
} from '#/common/constants/http-headers.constants.js'
import type { PrismaService } from '#/infrastructure/prisma/index.js'

export const ADVANCE_REQUESTS_PATH = '/api/v1/advance-requests'

/** Versiones legales que acepta `validForm()`; `ensureLegalDocumentVersions` las deja vigentes. */
export const FIXTURE_LEGAL_VERSIONS = { terms: '2026-09', privacy: '2026-09' } as const

/** Formulario válido para SEA (`createPayer`) y el XML por defecto de `buildInvoiceXml`. */
export function validForm(overrides: Partial<AdvanceRequestForm> = {}): AdvanceRequestForm {
  return {
    payerSlug: 'sea',
    contact: {
      fullName: 'Ana Pérez',
      dni: '46728673',
      mobile: '987654321',
      email: 'ana@proveedor.pe',
      isLegalRepresentative: true,
      contactTimeSlot: 'MORNING',
    },
    company: { ruc: '20100070970', legalName: 'PROVEEDOR EJEMPLO S.A.C.' },
    financing: { requestedAmount: '8000.00', purpose: 'Capital de trabajo' },
    cavaliRegistration: 'UNKNOWN',
    consents: {
      terms: true,
      personalData: true,
      termsVersion: FIXTURE_LEGAL_VERSIONS.terms,
      privacyVersion: FIXTURE_LEGAL_VERSIONS.privacy,
    },
    source: { utm: { utm_source: 'linkedin' }, referrer: 'https://www.linkedin.com/' },
    ...overrides,
  }
}

export const invoiceXml = (options: TestXmlOptions = {}): Buffer =>
  Buffer.from(buildInvoiceXml(options), 'utf8')

export const pdf = (): Buffer => Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'latin1')

export const newIdempotencyKey = (): string => randomUUID()

export type SubmitOptions = {
  /** Objeto (se envía como JSON) o texto tal cual. Por defecto, `validForm()`. */
  form?: unknown
  /** Por defecto, un XML válido `F001-123.xml`. */
  xml?: ReadonlyArray<readonly [content: Buffer, name: string]>
  pdf?: ReadonlyArray<readonly [content: Buffer, name: string]>
  /** Archivos en otros campos, para probar los campos no permitidos. */
  otherFiles?: ReadonlyArray<readonly [field: string, content: Buffer, name: string]>
  /** `null` no envía la cabecera. */
  token?: string | null
  /** `null` no envía la cabecera. Por defecto, una clave nueva. */
  idempotencyKey?: string | null
  correlationId?: string
}

/**
 * `POST /api/v1/advance-requests` con supertest. Todos los adjuntos son `Buffer`, así form-data
 * calcula el largo y la petición lleva `Content-Length`.
 */
export function submitAdvanceRequest(app: NestExpressApplication, options: SubmitOptions = {}) {
  let req = request(app.getHttpServer()).post(ADVANCE_REQUESTS_PATH)
  if (options.token !== null)
    req = req.set(CAPTCHA_TOKEN_HEADER, options.token ?? 'token-de-prueba')
  if (options.idempotencyKey !== null) {
    req = req.set(IDEMPOTENCY_KEY_HEADER, options.idempotencyKey ?? newIdempotencyKey())
  }
  if (options.correlationId !== undefined)
    req = req.set(CORRELATION_ID_HEADER, options.correlationId)
  const form = options.form ?? validForm()
  req = req.field('form', typeof form === 'string' ? form : JSON.stringify(form))
  for (const [content, name] of options.xml ?? [[invoiceXml(), 'F001-123.xml'] as const]) {
    req = req.attach('xml', content, name)
  }
  for (const [content, name] of options.pdf ?? []) req = req.attach('pdf', content, name)
  for (const [field, content, name] of options.otherFiles ?? [])
    req = req.attach(field, content, name)
  return req
}

/**
 * Deja vigentes (sin `retired_at`) las versiones legales de `validForm()`. No depende de las que
 * siembre `truncateAll`: si ya existen, no las toca.
 */
export async function ensureLegalDocumentVersions(prisma: PrismaService): Promise<void> {
  const publishedAt = new Date('2026-09-01T00:00:00.000Z')
  await prisma.legalDocumentVersion.createMany({
    data: [
      {
        type: 'TERMS',
        version: FIXTURE_LEGAL_VERSIONS.terms,
        url: `https://anticipate.pe/legal/terminos/${FIXTURE_LEGAL_VERSIONS.terms}`,
        sha256: 'a'.repeat(64),
        publishedAt,
      },
      {
        type: 'PERSONAL_DATA',
        version: FIXTURE_LEGAL_VERSIONS.privacy,
        url: `https://anticipate.pe/legal/datos-personales/${FIXTURE_LEGAL_VERSIONS.privacy}`,
        sha256: 'b'.repeat(64),
        publishedAt,
      },
    ],
    skipDuplicates: true,
  })
  await prisma.legalDocumentVersion.updateMany({
    where: {
      OR: [
        { type: 'TERMS', version: FIXTURE_LEGAL_VERSIONS.terms },
        { type: 'PERSONAL_DATA', version: FIXTURE_LEGAL_VERSIONS.privacy },
      ],
    },
    data: { retiredAt: null },
  })
}
