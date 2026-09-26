import { FORM_MESSAGES } from '@anticipate/shared/advance-request'
import { Controller, Post } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { Test } from '@nestjs/testing'
import type { Request } from 'express'
import { describe, expect, it } from 'vitest'
import { ApiValidationError, isApplicationError } from '#/common/exceptions/index.js'
import { testConfig } from '../../../../../test/support/config.js'
import {
  advanceRequestMultipartLimits,
  MAX_FILES_PER_FIELD,
  MAX_FORM_FIELD_BYTES,
} from './constants/multipart.constants.js'
import { readIdempotencyKey } from './decorators/idempotency-key.decorator.js'
import { AdvanceRequestFormPipe } from './pipes/advance-request-form.pipe.js'
import { CreateAdvanceRequestDocs } from './swagger/advance-requests.swagger.js'

const KEY = '0192F3A0-7C1E-7D2A-9B3C-4D5E6F708192'

const requestWith = (headers: Record<string, string>) =>
  ({ get: (name: string) => headers[name.toLowerCase()] }) as unknown as Request

const VALID_FORM = {
  payerSlug: 'sea',
  contact: {
    fullName: 'Ana Pérez',
    dni: '46728673',
    mobile: '987654321',
    email: 'Ana@Proveedor.pe',
    isLegalRepresentative: true,
    contactTimeSlot: 'MORNING',
  },
  company: { ruc: '20100070970', legalName: 'PROVEEDOR EJEMPLO S.A.C.' },
  financing: { requestedAmount: '8000.00' },
  cavaliRegistration: 'UNKNOWN',
  consents: { terms: true, personalData: true, termsVersion: '2026-09', privacyVersion: '2026-09' },
}

function violationsOf(run: () => unknown): { field: string; messages: string[] }[] {
  try {
    run()
  } catch (error) {
    if (error instanceof ApiValidationError) return [...error.violations]
    throw error
  }
  throw new Error('se esperaba un ApiValidationError')
}

describe('AdvanceRequestFormPipe', () => {
  const pipe = new AdvanceRequestFormPipe()

  it('devuelve el formulario normalizado por el esquema de shared', () => {
    expect(pipe.transform(JSON.stringify(VALID_FORM)).contact.email).toBe('ana@proveedor.pe')
  })

  it('sin la parte form o con un JSON inválido: una violación en form', () => {
    for (const value of [undefined, '{no es json', 42]) {
      expect(violationsOf(() => pipe.transform(value))).toEqual([
        { field: 'form', messages: [FORM_MESSAGES.form] },
      ])
    }
  })

  it('un formulario inválido: una violación por campo, con la ruta dentro del formulario', () => {
    const invalid = { ...VALID_FORM, company: { ruc: '123', legalName: 'X' } }
    const fields = violationsOf(() => pipe.transform(JSON.stringify(invalid))).map((v) => v.field)
    expect(fields).toEqual(expect.arrayContaining(['company.ruc', 'company.legalName']))
    expect(violationsOf(() => pipe.transform('[]')).map((v) => v.field)).toEqual(['form'])
  })
})

describe('readIdempotencyKey', () => {
  it('devuelve el UUID en minúsculas', () => {
    expect(readIdempotencyKey(requestWith({ 'idempotency-key': ` ${KEY} ` }))).toBe(
      KEY.toLowerCase(),
    )
  })

  it('sin cabecera, repetida o que no es UUID: 400 IDEMPOTENCY_KEY_INVALID', () => {
    for (const headers of [
      {},
      { 'idempotency-key': `${KEY}, ${KEY}` },
      { 'idempotency-key': 'x' },
    ]) {
      try {
        readIdempotencyKey(requestWith(headers))
        throw new Error('se esperaba un rechazo')
      } catch (error) {
        expect(isApplicationError(error) && error.publicCode).toBe('IDEMPOTENCY_KEY_INVALID')
      }
    }
  })
})

describe('advanceRequestMultipartLimits', () => {
  it('toma los topes de la configuración, con un solo campo de texto', () => {
    expect(advanceRequestMultipartLimits(testConfig({ UPLOAD_MAX_FILES: '20' }))).toEqual({
      files: 20,
      fileSize: 95_000_000,
      parts: 21,
      fields: 1,
      fieldSize: MAX_FORM_FIELD_BYTES,
    })
  })

  it('el tope fijo por campo cubre el máximo que admite UPLOAD_MAX_FILES', () => {
    const config = testConfig({ UPLOAD_MAX_FILES: String(MAX_FILES_PER_FIELD) })
    expect(advanceRequestMultipartLimits(config).files).toBe(MAX_FILES_PER_FIELD)
  })
})

describe('CreateAdvanceRequestDocs', () => {
  @Controller('docs-probe')
  class DocsProbeController {
    @Post()
    @CreateAdvanceRequestDocs()
    create() {
      return { publicCode: 'ANT-2026-000001' }
    }
  }

  it('documenta el multipart, las cabeceras, el 201 y los errores de la ruta', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [DocsProbeController],
    }).compile()
    const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false })
    await app.init()
    try {
      const operation = SwaggerModule.createDocument(app, new DocumentBuilder().build()).paths[
        '/docs-probe'
      ]?.post
      const body = operation?.requestBody
      expect(body !== undefined && 'content' in body ? Object.keys(body.content) : []).toEqual([
        'multipart/form-data',
      ])
      expect(operation?.parameters?.map((p) => ('name' in p ? p.name : ''))).toEqual(
        expect.arrayContaining(['x-turnstile-token', 'idempotency-key']),
      )
      expect(Object.keys(operation?.responses ?? {})).toEqual(
        expect.arrayContaining(['201', '400', '403', '411', '413', '422', '429', '500', '503']),
      )
    } finally {
      await app.close()
    }
  })
})
