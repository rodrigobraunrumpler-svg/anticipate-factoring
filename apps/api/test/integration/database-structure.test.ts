import { CLOSE_REASONS_BY_STATUS, TRANSITIONS } from '@anticipate/shared/advance-request'
import { isValidRuc } from '@anticipate/shared/identity'
import { invoiceKey } from '@anticipate/shared/invoice'
import { publicPayerSchema } from '@anticipate/shared/payer'
import fc from 'fast-check'
import pg from 'pg'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '#/infrastructure/prisma/id.js'
import { PrismaService } from '#/infrastructure/prisma/prisma.service.js'
import { createTestApp } from '../support/app.js'
import { testConfig } from '../support/config.js'
import { createTestPrisma, truncateAll } from '../support/db.js'
import { type CompleteAdvanceRequest, createCompleteAdvanceRequest } from '../support/factories.js'

const db = createTestPrisma()
// SQL directo, sin Prisma: el error de node-postgres trae `code` y `constraint` tal como los manda
// PostgreSQL (los triggers ponen el nombre de su regla en CONSTRAINT).
const pool = new pg.Pool({ connectionString: testConfig().database.url, max: 2 })

type SqlError = Error & { code?: string; constraint?: string }
type Row = Record<string, unknown>

afterAll(async () => {
  await pool.end()
  await db.close()
})

beforeEach(async () => {
  await truncateAll(db.prisma)
})

/** Corre `work` en una transacción que se deshace (o se confirma) y devuelve el error, si hubo. */
async function sqlError(
  work: (client: pg.PoolClient) => Promise<unknown>,
  end: 'ROLLBACK' | 'COMMIT' = 'ROLLBACK',
): Promise<SqlError | null> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await work(client)
    await client.query(end)
    return null
  } catch (error) {
    await client.query('ROLLBACK')
    return error as SqlError
  } finally {
    client.release()
  }
}

/** Los objetos van como JSON (columnas jsonb); los arreglos, como arreglos de PostgreSQL. */
function sqlValue(value: unknown): unknown {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? JSON.stringify(value)
    : value
}

/** El INSERT de una fila, con sus valores como parámetros numerados desde `firstParam`. */
function insertSql(table: string, row: Row, firstParam = 1): { text: string; values: unknown[] } {
  const columns = Object.keys(row)
  return {
    text: `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${columns.map((_, i) => `$${firstParam + i}`).join(', ')})`,
    values: Object.values(row).map(sqlValue),
  }
}

function insert(client: pg.ClientBase, table: string, row: Row) {
  const { text, values } = insertSql(table, row)
  return client.query(text, values)
}

const OTHER_ID = '0199a000-0000-7000-8000-000000000001'
const UUID_V4 = '1b4e28ba-2fa1-4d2c-883f-0016d3cca427'
const HEX_64 = 'ab'.repeat(32)
const NOW = '2026-09-25T12:00:00.000Z'

/**
 * Una fila por tabla que cumple todas sus CHECK. Las FK apuntan a ids que no existen: PostgreSQL
 * evalúa las CHECK al insertar la fila y las FK al terminar la sentencia, así que una fila que
 * rompe una CHECK falla con el nombre de esa CHECK y la fila base falla solo por FK (23503).
 */
const BASE: Record<string, () => Row> = {
  payers: () => ({
    slug: 'base',
    ruc: '20131312955',
    legal_name: 'Pagador Base S.A.',
    short_name: 'Base',
    advance_percent: '80.00',
    min_term_days: 15,
    max_invoices: 10,
    allowed_currencies: ['PEN'],
    accent_color: '#0E7C86',
    logo_url: 'https://cdn.anticipate.pe/logos/base.png',
    texts: { title: 'Adelanta tus facturas' },
  }),
  suppliers: () => ({ ruc: '20100070970', legal_name: 'Proveedor Base S.A.C.' }),
  legal_representatives: () => ({ supplier_id: OTHER_ID, full_name: 'Ana Pérez', dni: '46728673' }),
  supplier_documents: () => ({
    supplier_id: OTHER_ID,
    representative_id: OTHER_ID,
    type: 'REPRESENTATIVE_ID',
    status: 'PENDING_REVIEW',
    file_id: OTHER_ID,
  }),
  advance_requests: () => ({
    id: newId(),
    public_code: 'ANT-2026-000999',
    idempotency_key: newId(),
    request_fingerprint: HEX_64,
    payer_id: OTHER_ID,
    payer_ruc: '20131312955',
    supplier_id: OTHER_ID,
    supplier_ruc: '20100070970',
    supplier_legal_name: 'Proveedor Base S.A.C.',
    contact_full_name: 'Ana Pérez',
    contact_dni: '46728673',
    contact_mobile: '987654321',
    contact_email: 'ana@proveedor.pe',
    is_legal_representative: false,
    contact_job_title: 'Gerente de finanzas',
    contact_time_slot: 'MORNING',
    requested_amount: '8000.00',
    currency: 'PEN',
    applied_advance_percent: '80.00',
    applied_min_term_days: 15,
    total_net_pending: '10620.00',
    max_amount: '8496.00',
    cavali_registration: 'UNKNOWN',
    invoice_count: 1,
    earliest_due_date: '2026-11-30',
  }),
  invoices: () => ({
    id: newId(),
    advance_request_id: OTHER_ID,
    request_status: 'NEW',
    currency: 'PEN',
    issuer_ruc: '20100070970',
    recipient_ruc: '20131312955',
    document_type: '01',
    series_number: 'F001-00000123',
    invoice_key: '20100070970|F001-123',
    issuer_name: 'Proveedor Base S.A.C.',
    payment_terms: 'CREDIT',
    total: '11800.00',
    net_pending_amount: '10620.00',
    issue_date: '2026-09-01',
    due_date: '2026-11-30',
    signed: true,
    xml_file_id: OTHER_ID,
  }),
  invoice_installments: () => ({
    invoice_id: OTHER_ID,
    number: 1,
    label: 'Cuota001',
    amount: '10620.00',
    due_date: '2026-11-30',
  }),
  stored_files: () => ({
    id: newId(),
    storage_bucket: 'anticipate-test',
    key: `base/${newId()}`,
    purpose: 'INVOICE_XML',
    content_type: 'application/xml',
    size_bytes: 1024,
    sha256: HEX_64,
  }),
  status_history: () => ({ advance_request_id: OTHER_ID, to_status: 'NEW', version: 1 }),
  consents: () => ({
    advance_request_id: OTHER_ID,
    type: 'TERMS',
    document_version: '2026-09',
    ip: '203.0.113.10',
    accepted_at: NOW,
  }),
  users: () => ({
    email: 'agente@anticipate.pe',
    full_name: 'Agente Base',
    password_hash: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA',
    role: 'AGENT',
  }),
  follow_ups: () => ({
    advance_request_id: OTHER_ID,
    user_id: OTHER_ID,
    channel: 'CALL',
    note: 'Llamada inicial',
  }),
  audit_logs: () => ({ action: 'advance-request.viewed', entity: 'advance_request' }),
  outbox_events: () => ({
    id: newId(),
    handler: 'email.team-alert',
    dedupe_key: `base:${newId()}`,
    event_type: 'advance-request.created',
    payload: { id: OTHER_ID, type: 'advance-request.created', version: 1 },
    advance_request_id: OTHER_ID,
    max_attempts: 5,
  }),
}

/**
 * Cada CHECK de la migración integrity con una fila que rompe solo esa regla. `disableTrigger`
 * es para los tres casos que, desde integrity_hardening, también rompen
 * advance_requests_initial_state (status o version fuera de NEW/1): ese trigger BEFORE INSERT
 * corre antes que las CHECK de la fila y la taparía. `sqlError` deshace la transacción, así que
 * desactivar el trigger ahí nunca se filtra a otro test (DDL transaccional).
 */
const CHECK_CASES: { constraint: string; table: string; row: Row; disableTrigger?: string }[] = [
  { constraint: 'payers_slug_check', table: 'payers', row: { slug: 'Sea' } },
  { constraint: 'payers_ruc_check', table: 'payers', row: { ruc: '20131312956' } },
  {
    constraint: 'payers_legal_name_check',
    table: 'payers',
    row: { legal_name: ' \u3000ab\u00a0' },
  },
  { constraint: 'payers_short_name_check', table: 'payers', row: { short_name: '\ta\n' } },
  { constraint: 'payers_advance_percent_check', table: 'payers', row: { advance_percent: '0.50' } },
  { constraint: 'payers_min_term_days_check', table: 'payers', row: { min_term_days: -1 } },
  { constraint: 'payers_max_invoices_check', table: 'payers', row: { max_invoices: 0 } },
  {
    constraint: 'payers_allowed_currencies_check',
    table: 'payers',
    row: { allowed_currencies: [] },
  },
  { constraint: 'payers_accent_color_check', table: 'payers', row: { accent_color: '#12345' } },
  {
    constraint: 'payers_logo_url_check',
    table: 'payers',
    row: { logo_url: 'javascript:alert(1)' },
  },
  {
    constraint: 'payers_texts_check',
    table: 'payers',
    row: { texts: { Title: 'Clave que no es camelCase' } },
  },
  { constraint: 'suppliers_ruc_check', table: 'suppliers', row: { ruc: '12345678901' } },
  { constraint: 'suppliers_legal_name_check', table: 'suppliers', row: { legal_name: '   ' } },
  {
    constraint: 'legal_representatives_dni_check',
    table: 'legal_representatives',
    row: { dni: '4672867' },
  },
  {
    constraint: 'legal_representatives_full_name_check',
    table: 'legal_representatives',
    row: { full_name: '  ' },
  },
  {
    constraint: 'supplier_documents_file_purpose_check',
    table: 'supplier_documents',
    row: { file_purpose: 'INVOICE_PDF' },
  },
  {
    constraint: 'supplier_documents_representative_check',
    table: 'supplier_documents',
    row: { representative_id: null },
  },
  {
    constraint: 'supplier_documents_valid_until_required_check',
    table: 'supplier_documents',
    row: { status: 'APPROVED', reviewed_by_id: OTHER_ID, reviewed_at: NOW },
  },
  {
    constraint: 'supplier_documents_valid_until_not_applicable_check',
    table: 'supplier_documents',
    row: { type: 'MASTER_AGREEMENT', representative_id: null, valid_until: '2027-09-01' },
  },
  {
    constraint: 'supplier_documents_issued_on_check',
    table: 'supplier_documents',
    row: {
      type: 'POWER_OF_ATTORNEY_CERTIFICATE',
      status: 'APPROVED',
      reviewed_by_id: OTHER_ID,
      reviewed_at: NOW,
      valid_until: '2027-09-01',
    },
  },
  {
    constraint: 'supplier_documents_review_check',
    table: 'supplier_documents',
    row: { reviewed_at: NOW },
  },
  {
    constraint: 'supplier_documents_validity_range_check',
    table: 'supplier_documents',
    row: { issued_on: '2026-10-01', valid_until: '2026-09-01' },
  },
  {
    constraint: 'advance_requests_id_version_check',
    table: 'advance_requests',
    row: { id: UUID_V4 },
  },
  {
    constraint: 'advance_requests_public_code_check',
    table: 'advance_requests',
    row: { public_code: 'ant-2026-000999' },
  },
  {
    constraint: 'advance_requests_request_fingerprint_check',
    table: 'advance_requests',
    row: { request_fingerprint: 'G'.repeat(64) },
  },
  {
    constraint: 'advance_requests_contact_full_name_check',
    table: 'advance_requests',
    row: { contact_full_name: ' ab ' },
  },
  {
    constraint: 'advance_requests_contact_dni_check',
    table: 'advance_requests',
    row: { contact_dni: '4672867' },
  },
  {
    constraint: 'advance_requests_contact_mobile_check',
    table: 'advance_requests',
    row: { contact_mobile: '887654321' },
  },
  {
    constraint: 'advance_requests_contact_email_check',
    table: 'advance_requests',
    row: { contact_email: 'Ana@proveedor.pe' },
  },
  {
    constraint: 'advance_requests_contact_job_title_check',
    table: 'advance_requests',
    row: { contact_job_title: null },
  },
  {
    constraint: 'advance_requests_legal_representative_check',
    table: 'advance_requests',
    row: { is_legal_representative: true },
  },
  {
    constraint: 'advance_requests_requested_amount_check',
    table: 'advance_requests',
    row: { requested_amount: '8496.01' },
  },
  {
    constraint: 'advance_requests_snapshot_check',
    table: 'advance_requests',
    row: { applied_min_term_days: -1 },
  },
  {
    constraint: 'advance_requests_max_amount_check',
    table: 'advance_requests',
    row: { max_amount: '8496.01' },
  },
  {
    constraint: 'advance_requests_version_check',
    table: 'advance_requests',
    row: { version: 0 },
    disableTrigger: 'advance_requests_initial_state',
  },
  {
    constraint: 'advance_requests_close_reason_check',
    table: 'advance_requests',
    row: { close_reason: 'OTHER', close_reason_detail: 'Motivo' },
  },
  {
    constraint: 'advance_requests_close_reason_detail_check',
    table: 'advance_requests',
    row: { status: 'WITHDRAWN', close_reason: 'OTHER', closed_at: NOW },
    disableTrigger: 'advance_requests_initial_state',
  },
  {
    constraint: 'advance_requests_closed_at_check',
    table: 'advance_requests',
    row: { closed_at: NOW },
  },
  {
    constraint: 'advance_requests_next_action_check',
    table: 'advance_requests',
    row: { status: 'DISBURSED', closed_at: NOW, next_action_at: NOW },
    disableTrigger: 'advance_requests_initial_state',
  },
  {
    constraint: 'advance_requests_utm_check',
    table: 'advance_requests',
    row: { utm: '["utm_source"]' },
  },
  {
    constraint: 'advance_requests_referrer_check',
    table: 'advance_requests',
    row: { referrer: 'android-app://com.google' },
  },
  {
    constraint: 'advance_requests_purpose_check',
    table: 'advance_requests',
    row: { purpose: '   ' },
  },
  {
    constraint: 'advance_requests_invoice_count_check',
    table: 'advance_requests',
    row: { invoice_count: 0 },
  },
  { constraint: 'invoices_id_version_check', table: 'invoices', row: { id: UUID_V4 } },
  { constraint: 'invoices_document_type_check', table: 'invoices', row: { document_type: '03' } },
  { constraint: 'invoices_payment_terms_check', table: 'invoices', row: { payment_terms: 'CASH' } },
  {
    constraint: 'invoices_series_number_check',
    table: 'invoices',
    row: { series_number: 'F01-123', invoice_key: '20100070970|F01-123' },
  },
  {
    constraint: 'invoices_invoice_key_check',
    table: 'invoices',
    row: { invoice_key: '20100070970|F001-00000123' },
  },
  {
    constraint: 'invoices_net_pending_amount_check',
    table: 'invoices',
    row: { net_pending_amount: '11800.01' },
  },
  { constraint: 'invoices_dates_check', table: 'invoices', row: { due_date: '2026-08-31' } },
  {
    constraint: 'invoices_xml_file_purpose_check',
    table: 'invoices',
    row: { xml_file_purpose: 'INVOICE_PDF' },
  },
  {
    constraint: 'invoices_pdf_file_purpose_check',
    table: 'invoices',
    row: { pdf_file_purpose: 'INVOICE_XML' },
  },
  { constraint: 'invoices_detraction_check', table: 'invoices', row: { detraction: '"10%"' } },
  {
    constraint: 'invoice_installments_number_check',
    table: 'invoice_installments',
    row: { number: 0 },
  },
  {
    constraint: 'invoice_installments_amount_check',
    table: 'invoice_installments',
    row: { amount: '0.00' },
  },
  {
    constraint: 'invoice_installments_label_check',
    table: 'invoice_installments',
    row: { label: ' ' },
  },
  { constraint: 'stored_files_id_version_check', table: 'stored_files', row: { id: UUID_V4 } },
  { constraint: 'stored_files_size_bytes_check', table: 'stored_files', row: { size_bytes: 0 } },
  {
    constraint: 'stored_files_sha256_check',
    table: 'stored_files',
    row: { sha256: 'AB'.repeat(32) },
  },
  {
    constraint: 'stored_files_content_type_check',
    table: 'stored_files',
    row: { purpose: 'SUPPLIER_DOCUMENT', content_type: 'text/plain' },
  },
  {
    constraint: 'stored_files_xml_content_type_check',
    table: 'stored_files',
    row: { content_type: 'application/pdf' },
  },
  {
    constraint: 'stored_files_pdf_content_type_check',
    table: 'stored_files',
    row: { purpose: 'INVOICE_PDF', content_type: 'image/png' },
  },
  { constraint: 'stored_files_status_check', table: 'stored_files', row: { status: 'ATTACHED' } },
  { constraint: 'status_history_initial_check', table: 'status_history', row: { version: 2 } },
  {
    constraint: 'status_history_initial_status_check',
    table: 'status_history',
    row: { to_status: 'CONTACTED' },
  },
  { constraint: 'status_history_actor_check', table: 'status_history', row: { user_id: OTHER_ID } },
  {
    constraint: 'status_history_close_reason_check',
    table: 'status_history',
    row: { from_status: 'NEW', to_status: 'WITHDRAWN', version: 2 },
  },
  {
    constraint: 'status_history_close_reason_detail_check',
    table: 'status_history',
    row: { from_status: 'NEW', to_status: 'WITHDRAWN', version: 2, close_reason: 'OTHER' },
  },
  {
    constraint: 'consents_document_version_check',
    table: 'consents',
    row: { document_version: ' ' },
  },
  { constraint: 'users_email_check', table: 'users', row: { email: 'Agente@anticipate.pe' } },
  { constraint: 'users_full_name_check', table: 'users', row: { full_name: ' ' } },
  {
    constraint: 'users_password_hash_check',
    table: 'users',
    row: { password_hash: '$2b$10$bcrypt' },
  },
  { constraint: 'follow_ups_note_check', table: 'follow_ups', row: { note: '  ' } },
  { constraint: 'audit_logs_actor_check', table: 'audit_logs', row: { user_id: OTHER_ID } },
  { constraint: 'outbox_events_id_version_check', table: 'outbox_events', row: { id: UUID_V4 } },
  {
    constraint: 'outbox_events_handler_check',
    table: 'outbox_events',
    row: { handler: 'Email.TeamAlert' },
  },
  {
    constraint: 'outbox_events_event_type_check',
    table: 'outbox_events',
    row: { event_type: ' ', payload: { id: OTHER_ID, type: ' ', version: 1 } },
  },
  {
    constraint: 'outbox_events_payload_check',
    table: 'outbox_events',
    row: { payload: { id: OTHER_ID, version: 1 } },
  },
  {
    constraint: 'outbox_events_aggregate_check',
    table: 'outbox_events',
    row: { advance_request_id: null },
  },
  { constraint: 'outbox_events_attempts_check', table: 'outbox_events', row: { attempts: 6 } },
  {
    constraint: 'outbox_events_lease_check',
    table: 'outbox_events',
    row: { status: 'PROCESSING' },
  },
  {
    constraint: 'outbox_events_published_check',
    table: 'outbox_events',
    row: { published_at: NOW },
  },
]

async function queryRows<T extends pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await pool.query<T>(sql, params)).rows
}

const updateError = (sql: string, params: unknown[]) =>
  sqlError((client) => client.query(sql, params))

type AggregateRows = {
  requestId: string
  invoiceId: string
  rows: (readonly [table: string, row: Row])[]
}

/**
 * Las filas de un agregado completo, en orden de inserción: archivo XML `ATTACHED`, solicitud,
 * factura, su cuota por el neto, los dos consentimientos y el historial inicial. Usa el pagador y el
 * proveedor de `seed`; los tests que las insertan a mano limpian con `purgeAggregate`.
 */
function aggregateRows(seed: CompleteAdvanceRequest): AggregateRows {
  const requestId = newId()
  const invoiceId = newId()
  const xmlFileId = newId()
  // La fábrica solo usa la serie F001: la factura de este agregado nunca choca con la de `seed`.
  const seriesNumber = 'F002-00000001'
  return {
    requestId,
    invoiceId,
    rows: [
      [
        'stored_files',
        { ...BASE.stored_files?.(), id: xmlFileId, status: 'ATTACHED', attached_at: NOW },
      ],
      [
        'advance_requests',
        {
          ...BASE.advance_requests?.(),
          id: requestId,
          payer_id: seed.payerId,
          payer_ruc: seed.payerRuc,
          supplier_id: seed.supplierId,
          supplier_ruc: seed.supplierRuc,
        },
      ],
      [
        'invoices',
        {
          ...BASE.invoices?.(),
          id: invoiceId,
          advance_request_id: requestId,
          issuer_ruc: seed.supplierRuc,
          recipient_ruc: seed.payerRuc,
          series_number: seriesNumber,
          invoice_key: invoiceKey({ issuerRuc: seed.supplierRuc, seriesNumber }),
          xml_file_id: xmlFileId,
        },
      ],
      ['invoice_installments', { ...BASE.invoice_installments?.(), invoice_id: invoiceId }],
      ['consents', { ...BASE.consents?.(), advance_request_id: requestId, type: 'TERMS' }],
      ['consents', { ...BASE.consents?.(), advance_request_id: requestId, type: 'PERSONAL_DATA' }],
      ['status_history', { ...BASE.status_history?.(), advance_request_id: requestId }],
    ],
  }
}

/**
 * Todas las filas en UNA sentencia: cada INSERT menos el último va en su propia CTE que modifica
 * datos. Las CTE comparten la foto de la sentencia y ninguna ve lo que escriben las otras; la FK y los
 * triggers AFTER ROW recién lo ven al terminar la sentencia.
 */
function insertInOneStatement(client: pg.ClientBase, rows: AggregateRows['rows']) {
  const values: unknown[] = []
  const statements = rows.map(([table, row]) => {
    const statement = insertSql(table, row, values.length + 1)
    values.push(...statement.values)
    return statement.text
  })
  const steps = statements.slice(0, -1).map((text, i) => `step_${i} AS (${text})`)
  return client.query(`WITH ${steps.join(',\n')}\n${statements.at(-1)}`, values)
}

/** El INSERT de una fila con sus valores escritos como literales, para el cuerpo de un bloque DO. */
function insertLiteral(table: string, row: Row): string {
  const columns = Object.keys(row)
  const values = Object.values(row).map((value) => {
    if (Array.isArray(value)) throw new Error(`insertLiteral no escribe arreglos (${table}).`)
    return value === null || value === undefined
      ? 'NULL'
      : pg.escapeLiteral(String(sqlValue(value)))
  })
  return `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${values.join(', ')})`
}

/**
 * Borra entero un agregado ya confirmado con el escape de la purga por retención, en una transacción
 * que se confirma (así corren los constraint triggers diferidos de la purga). Es como limpian lo que
 * confirman los tests que insertan a mano; devuelve el error, si hubo.
 */
function purgeAggregate(requestId: string): Promise<SqlError | null> {
  return sqlError(async (client) => {
    await client.query("SET LOCAL app.retention_purge = 'on'")
    const { rows: files } = await client.query<{ id: string }>(
      `SELECT file.id FROM invoices i CROSS JOIN LATERAL (VALUES (i.xml_file_id), (i.pdf_file_id)) AS file(id)
       WHERE i.advance_request_id = $1 AND file.id IS NOT NULL`,
      [requestId],
    )
    await client.query(
      'DELETE FROM invoice_installments WHERE invoice_id IN (SELECT id FROM invoices WHERE advance_request_id = $1)',
      [requestId],
    )
    await client.query('DELETE FROM invoices WHERE advance_request_id = $1', [requestId])
    await client.query('DELETE FROM consents WHERE advance_request_id = $1', [requestId])
    await client.query('DELETE FROM status_history WHERE advance_request_id = $1', [requestId])
    await client.query('DELETE FROM stored_files WHERE id = ANY($1::uuid[])', [
      files.map((file) => file.id),
    ])
    await client.query('DELETE FROM advance_requests WHERE id = $1', [requestId])
  }, 'COMMIT')
}

/** Filas de cada parte del agregado que siguen en la base. */
async function aggregateLeftovers(requestId: string, invoiceIds: string[], fileIds: string[]) {
  const [counts] = await queryRows<Record<string, number>>(
    `SELECT (SELECT count(*)::int FROM advance_requests WHERE id = $1) AS advance_requests,
            (SELECT count(*)::int FROM invoices WHERE advance_request_id = $1) AS invoices,
            (SELECT count(*)::int FROM invoice_installments WHERE invoice_id = ANY($2::uuid[])) AS invoice_installments,
            (SELECT count(*)::int FROM consents WHERE advance_request_id = $1) AS consents,
            (SELECT count(*)::int FROM status_history WHERE advance_request_id = $1) AS status_history,
            (SELECT count(*)::int FROM stored_files WHERE id = ANY($3::uuid[])) AS stored_files`,
    [requestId, invoiceIds, fileIds],
  )
  return counts
}

const installmentsOf = (invoiceId: string) =>
  queryRows<{ number: number; amount: string }>(
    'SELECT number, amount::text AS amount FROM invoice_installments WHERE invoice_id = $1 ORDER BY number',
    [invoiceId],
  )

/**
 * Una sola sentencia que inserta una cuota para la factura `$1` y después espera el candado de aviso
 * `$2`. La primera rama del UNION ALL entrega su fila de inmediato: los triggers BEFORE ROW de esa
 * fila ya corrieron y la fila ya está escrita. La segunda llama a pg_advisory_xact_lock y no entrega
 * ninguna fila (el void que devuelve nunca es NULL). La sentencia termina, y con ella corren la FK y
 * los triggers AFTER ROW, recién cuando el dueño del candado lo suelta. La cuota vence después de la
 * fecha más próxima del agregado, así que el trigger diferido del agregado no la nota: solo el gate
 * de las cuotas puede rechazarla.
 */
const INSTALLMENT_BLOCKED_ON_LOCK = `
  INSERT INTO invoice_installments (invoice_id, number, label, amount, due_date)
  SELECT $1::uuid, 2, 'Cuota002', 100.00, '2026-12-15'::date
  UNION ALL
  SELECT $1::uuid, 3, 'Cuota003', 100.00, '2026-12-15'::date
  FROM pg_advisory_xact_lock($2::bigint) AS gate(result) WHERE gate.result IS NULL`

/** Espera, consultando pg_locks, a que la sesión `pid` quede bloqueada en un candado de aviso. */
async function waitForAdvisoryLockWait(pid: number, finished: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  for (;;) {
    const [row] = await queryRows<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND NOT granted
       ) AS waiting`,
      [pid],
    )
    if (row?.waiting) return
    if (finished()) throw new Error('La sentencia de B terminó sin esperar el candado de aviso.')
    if (Date.now() > deadline) throw new Error('B no quedó esperando el candado de aviso.')
  }
}

/**
 * La carrera entre dos transacciones, cada una en su propia conexión. A inserta un agregado completo
 * y, sin confirmar, toma el candado de aviso `lock`. B, con el aislamiento dado, corre
 * INSTALLMENT_BLOCKED_ON_LOCK para la factura de A: su fila pasa por los triggers BEFORE ROW con la
 * factura de A todavía sin confirmar y la sentencia queda esperando el candado. Cuando pg_locks
 * muestra a B esperando, A confirma, así que la sentencia de B termina con la factura de A ya
 * confirmada. Devuelve el error de B (de la sentencia o de su COMMIT), o null si B confirmó.
 */
async function raceForeignInstallment(
  seed: CompleteAdvanceRequest,
  isolation: 'READ COMMITTED' | 'REPEATABLE READ',
  lock: number,
): Promise<{ requestId: string; invoiceId: string; error: SqlError | null }> {
  const aggregate = aggregateRows(seed)
  const a = new pg.Client({ connectionString: testConfig().database.url })
  const b = new pg.Client({ connectionString: testConfig().database.url })
  await Promise.all([a.connect(), b.connect()])
  try {
    await a.query('BEGIN')
    for (const [table, row] of aggregate.rows) await insert(a, table, row)
    await a.query('SELECT pg_advisory_xact_lock($1::bigint)', [lock])

    const pid = (await b.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid
    await b.query(`BEGIN ISOLATION LEVEL ${isolation}`)
    let finished = false
    const outcome = b
      .query(INSTALLMENT_BLOCKED_ON_LOCK, [aggregate.invoiceId, lock])
      .then(() => b.query('COMMIT'))
      .then(
        () => null,
        async (error: unknown) => {
          await b.query('ROLLBACK').catch(() => undefined)
          return error as SqlError
        },
      )
      .finally(() => {
        finished = true
      })
    await waitForAdvisoryLockWait(pid ?? -1, () => finished)
    await a.query('COMMIT')
    return { requestId: aggregate.requestId, invoiceId: aggregate.invoiceId, error: await outcome }
  } finally {
    await Promise.all([a.end(), b.end()])
  }
}

/**
 * Una tabla temporal con el nombre de una tabla real la tapa para todo nombre sin esquema de la
 * sesión: si el search_path no nombra pg_temp, PostgreSQL busca las relaciones primero en el esquema
 * temporal de la sesión, y TEMP se concede a PUBLIC por defecto. En una sesión propia (un pg.Client
 * suelto, así la tabla temporal nunca queda en una conexión del pool), `shadow` crea esa tabla con sus
 * filas falsas (ON COMMIT DROP) y `attack` corre con ella puesta, en una transacción que se confirma.
 * Devuelve si `table` sin esquema resolvía de verdad a la temporal justo antes del ataque (así un test
 * no puede pasar porque la tabla falsa nunca tapó nada) y el error de la transacción, o null si
 * confirmó.
 */
async function commitWithShadowTable(
  table: string,
  shadow: (client: pg.ClientBase) => Promise<unknown>,
  attack: (client: pg.ClientBase) => Promise<unknown>,
): Promise<{ shadowed: boolean | undefined; error: SqlError | null }> {
  const client = new pg.Client({ connectionString: testConfig().database.url })
  await client.connect()
  let shadowed: boolean | undefined
  try {
    await client.query('BEGIN')
    await shadow(client)
    const { rows } = await client.query<{ shadowed: boolean }>(
      "SELECT relpersistence = 't' AS shadowed FROM pg_class WHERE oid = to_regclass($1)",
      [table],
    )
    shadowed = rows[0]?.shadowed
    await attack(client)
    await client.query('COMMIT')
    return { shadowed, error: null }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    return { shadowed, error: error as SqlError }
  } finally {
    await client.end()
  }
}

/** El id de la única factura de una solicitud creada por la fábrica. */
function onlyInvoiceId(request: CompleteAdvanceRequest): string {
  const [invoice, ...rest] = request.invoices
  if (!invoice || rest.length > 0) throw new Error('La solicitud no tiene exactamente una factura.')
  return invoice.id
}

describe('estructura de la base', () => {
  it('(a) toda FK tiene un índice no parcial que empieza por su primera columna', async () => {
    const WHITELIST = ['supplier_documents.reviewed_by_id', 'status_history.user_id']
    const foreignKeys = await queryRows<{ fk: string; name: string; covered: boolean }>(`
      SELECT c.conrelid::regclass::text || '.' || (
               SELECT string_agg(a.attname, ',' ORDER BY k.ord)
               FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
             ) AS fk,
             c.conname AS name,
             EXISTS (
               SELECT 1 FROM pg_index i
               WHERE i.indrelid = c.conrelid AND i.indpred IS NULL AND i.indisvalid AND i.indkey[0] = c.conkey[1]
             ) AS covered
      FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public' AND c.contype = 'f'`)
    expect(foreignKeys.map((row) => row.name)).toContain('invoices_request_scope_fkey')
    expect(
      foreignKeys.filter((row) => !row.covered && !WHITELIST.includes(row.fk)).map((row) => row.fk),
    ).toEqual([])
  })

  it('(b) las CHECK de la base son exactamente las de la migración integrity', async () => {
    const rows = await queryRows<{ name: string }>(`
      SELECT c.conname AS name FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public' AND c.contype = 'c'`)
    expect(rows.map((row) => row.name).sort()).toEqual(
      [...new Set(CHECK_CASES.map((c) => c.constraint))].sort(),
    )
  })

  // Las dos únicas CHECK que alguna vez se agregaron NOT VALID (integrity_hardening, sobre payers,
  // que ya existía fuera de la migración baseline) se validaron después, en su propia migración
  // (integrity_hardening_validate). Toda CHECK de la base, sin excepción, debe terminar validada:
  // una NOT VALID sin su VALIDATE deja una regla que no rige para las filas que ya estaban.
  it('(b) toda CHECK de la base está validada (ninguna quedó NOT VALID sin validar)', async () => {
    const rows = await queryRows<{ name: string; validated: boolean }>(`
      SELECT c.conname AS name, c.convalidated AS validated
      FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public' AND c.contype = 'c'`)
    expect(rows.filter((row) => !row.validated).map((row) => row.name)).toEqual([])
  })

  it('(b) la clave canónica de la factura usa la misma función que prueba (f)', async () => {
    const [row] = await queryRows<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'invoices_invoice_key_check'`,
    )
    expect(row?.definition).toContain('canonical_invoice_key(')
  })

  it('(c) los índices parciales, descendentes, GIN y BRIN conservan su definición', async () => {
    const indexes = await queryRows<{ name: string; definition: string }>(`
      SELECT indexname AS name,
             regexp_replace(indexdef, '^CREATE (UNIQUE )?INDEX \\S+ ON ', 'CREATE \\1INDEX ON ') AS definition
      FROM pg_indexes WHERE schemaname = 'public'`)
    const definitions = indexes.map((index) => index.definition)
    const expected = [
      'CREATE INDEX ON public.advance_requests USING btree (id DESC) WHERE (closed_at IS NULL)',
      'CREATE INDEX ON public.advance_requests USING btree (status, id DESC)',
      'CREATE INDEX ON public.advance_requests USING btree (payer_id, id DESC)',
      'CREATE INDEX ON public.advance_requests USING btree (supplier_id, id DESC)',
      'CREATE INDEX ON public.advance_requests USING btree (assigned_to_id, id DESC) WHERE (closed_at IS NULL)',
      'CREATE INDEX ON public.advance_requests USING btree (next_action_at) WHERE ((closed_at IS NULL) AND (next_action_at IS NOT NULL))',
      'CREATE INDEX ON public.advance_requests USING btree (assigned_to_id, next_action_at) WHERE ((closed_at IS NULL) AND (next_action_at IS NOT NULL))',
      'CREATE INDEX ON public.advance_requests USING gin (contact_full_name gin_trgm_ops)',
      'CREATE INDEX ON public.suppliers USING gin (legal_name gin_trgm_ops)',
      'CREATE INDEX ON public.supplier_documents USING btree (valid_until) WHERE (superseded_at IS NULL)',
      "CREATE UNIQUE INDEX ON public.invoices USING btree (invoice_key) WHERE (request_status <> ALL (ARRAY['REJECTED'::advance_request_status, 'WITHDRAWN'::advance_request_status]))",
      "CREATE INDEX ON public.stored_files USING btree (created_at) WHERE (status = 'PENDING'::stored_file_status)",
      'CREATE INDEX ON public.stored_files USING btree (purge_after) WHERE ((purged_at IS NULL) AND (deleted_at IS NOT NULL))',
      'CREATE INDEX ON public.follow_ups USING btree (user_id, created_at DESC)',
      'CREATE UNIQUE INDEX ON public.status_history USING btree (advance_request_id) WHERE (from_status IS NULL)',
      'CREATE INDEX ON public.audit_logs USING btree (entity_id, created_at DESC)',
      'CREATE INDEX ON public.audit_logs USING btree (user_id, created_at DESC)',
      'CREATE INDEX ON public.audit_logs USING brin (created_at)',
      "CREATE INDEX ON public.outbox_events USING btree (handler, available_at) WHERE (status = 'PENDING'::outbox_status)",
      "CREATE INDEX ON public.outbox_events USING btree (lock_expires_at) WHERE (status = 'PROCESSING'::outbox_status)",
      "CREATE INDEX ON public.outbox_events USING btree (created_at DESC) WHERE (status = 'DEAD_LETTER'::outbox_status)",
    ]
    expect(expected.filter((definition) => !definitions.includes(definition))).toEqual([])

    // Nombres de los que dependen el código y el contrato (P2002 por nombre, rangos de la PK, búsquedas).
    expect(indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        'advance_requests_open_idx',
        'advance_requests_open_assigned_idx',
        'advance_requests_idempotency_key_key',
        'advance_requests_invoice_scope_key',
        'invoices_open_invoice_key_key',
        'status_history_one_initial_key',
        'outbox_events_dedupe_key_key',
        'suppliers_legal_name_trgm_idx',
        'audit_logs_created_brin_idx',
        'payers_id_ruc_key',
        'suppliers_id_ruc_key',
        'legal_representatives_id_supplier_key',
      ]),
    )
    const [scope] = await queryRows<{ on_update: string; on_delete: string }>(`
      SELECT confupdtype AS on_update, confdeltype AS on_delete FROM pg_constraint
      WHERE conname = 'invoices_request_scope_fkey'`)
    expect(scope).toEqual({ on_update: 'c', on_delete: 'r' })
  })

  it('(d) secuencia, funciones y triggers presentes', async () => {
    const [sequence] = await queryRows<{ data_type: string }>(`
      SELECT data_type FROM information_schema.sequences
      WHERE sequence_schema = 'public' AND sequence_name = 'advance_request_code_seq'`)
    expect(sequence).toEqual({ data_type: 'bigint' })

    const functions = await queryRows<{ name: string; volatility: string }>(`
      SELECT p.proname AS name, p.provolatile AS volatility
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prokind = 'f'`)
    const volatility = Object.fromEntries(functions.map((f) => [f.name, f.volatility]))
    for (const name of [
      'js_trim',
      'is_valid_ruc',
      'is_valid_payer_texts',
      'canonical_invoice_key',
      'uuidv7_floor',
    ]) {
      expect(volatility[name], name).toBe('i')
    }
    // js_length medía unidades UTF-16 y Zod 4 mide puntos de código (util.codePointLength): se
    // reemplazó por char_length (que ya cuenta puntos de código) y se eliminó (integrity_hardening).
    expect(volatility.js_length).toBeUndefined()
    for (const name of [
      'set_updated_at',
      'advance_requests_guard',
      'advance_requests_initial_state',
      'advance_requests_complete',
      'assert_advance_request_complete',
      'invoices_guard',
      'invoices_complete',
      'invoices_purge_requires_request_purge',
      'invoices_set_creating_xact_id',
      'invoice_installments_complete',
      'invoice_installments_same_transaction',
      'invoice_installments_purge_requires_invoice_purge',
      'consents_purge_requires_request_purge',
      'status_history_purge_requires_request_purge',
      'stored_files_guard',
      'reject_append_only_mutation',
      'outbox_events_guard',
    ]) {
      expect(volatility[name], name).toBeDefined()
    }

    const triggers = await queryRows<{
      table: string
      name: string
      timing: string
      events: string
    }>(`
      SELECT event_object_table AS table, trigger_name AS name, action_timing AS timing,
             string_agg(event_manipulation, ',' ORDER BY event_manipulation) AS events
      FROM information_schema.triggers WHERE trigger_schema = 'public'
      GROUP BY 1, 2, 3`)
    const withUpdatedAt = await queryRows<{ table: string }>(`
      SELECT c.table_name AS table FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND c.column_name = 'updated_at' AND t.table_type = 'BASE TABLE'`)
    expect(withUpdatedAt.length).toBeGreaterThanOrEqual(9)
    const key = (t: { table: string; name: string; timing: string; events: string }) =>
      `${t.table}:${t.name}:${t.timing}:${t.events}`
    expect(triggers.map(key).sort()).toEqual(
      [
        ...withUpdatedAt.map(({ table }) => ({
          table,
          name: `${table}_set_updated_at`,
          timing: 'BEFORE',
          events: 'UPDATE',
        })),
        {
          table: 'advance_requests',
          name: 'advance_requests_guard',
          timing: 'BEFORE',
          events: 'UPDATE',
        },
        {
          table: 'advance_requests',
          name: 'advance_requests_initial_state',
          timing: 'BEFORE',
          events: 'INSERT',
        },
        {
          table: 'advance_requests',
          name: 'advance_requests_complete',
          timing: 'AFTER',
          events: 'INSERT',
        },
        {
          table: 'invoices',
          name: 'invoices_guard',
          timing: 'BEFORE',
          events: 'DELETE,UPDATE',
        },
        {
          table: 'invoices',
          name: 'invoices_complete',
          timing: 'AFTER',
          events: 'INSERT',
        },
        {
          table: 'invoices',
          name: 'invoices_purge_requires_request_purge',
          timing: 'AFTER',
          events: 'DELETE',
        },
        {
          table: 'invoices',
          name: 'invoices_set_creating_xact_id',
          timing: 'BEFORE',
          events: 'INSERT',
        },
        {
          table: 'invoice_installments',
          name: 'invoice_installments_append_only',
          timing: 'BEFORE',
          events: 'DELETE,UPDATE',
        },
        {
          table: 'invoice_installments',
          name: 'invoice_installments_complete',
          timing: 'AFTER',
          events: 'INSERT',
        },
        {
          table: 'invoice_installments',
          name: 'invoice_installments_same_transaction',
          timing: 'AFTER',
          events: 'INSERT',
        },
        {
          table: 'invoice_installments',
          name: 'invoice_installments_purge_requires_invoice_purge',
          timing: 'AFTER',
          events: 'DELETE',
        },
        { table: 'stored_files', name: 'stored_files_guard', timing: 'BEFORE', events: 'UPDATE' },
        {
          table: 'status_history',
          name: 'status_history_append_only',
          timing: 'BEFORE',
          events: 'DELETE,UPDATE',
        },
        {
          table: 'status_history',
          name: 'status_history_purge_requires_request_purge',
          timing: 'AFTER',
          events: 'DELETE',
        },
        {
          table: 'audit_logs',
          name: 'audit_logs_append_only',
          timing: 'BEFORE',
          events: 'DELETE,UPDATE',
        },
        {
          table: 'consents',
          name: 'consents_append_only',
          timing: 'BEFORE',
          events: 'DELETE,UPDATE',
        },
        {
          table: 'consents',
          name: 'consents_purge_requires_request_purge',
          timing: 'AFTER',
          events: 'DELETE',
        },
        {
          table: 'outbox_events',
          name: 'outbox_events_guard',
          timing: 'BEFORE',
          events: 'DELETE,UPDATE',
        },
      ]
        .map(key)
        .sort(),
    )
    // Todas diferidas: una solicitud puede insertar sus facturas y cuotas después de sí misma (o
    // borrarlas en cualquier orden al purgar), todo en la misma transacción, y solo se comprueba
    // al confirmar.
    const deferredTriggers = await queryRows<{
      name: string
      deferrable: boolean
      deferred: boolean
    }>(`
      SELECT tgname AS name, tgdeferrable AS deferrable, tginitdeferred AS deferred FROM pg_trigger
      WHERE tgname IN (
        'advance_requests_complete', 'invoices_complete', 'invoice_installments_complete',
        'invoices_purge_requires_request_purge', 'invoice_installments_purge_requires_invoice_purge',
        'consents_purge_requires_request_purge', 'status_history_purge_requires_request_purge'
      )
      ORDER BY tgname`)
    expect(deferredTriggers).toEqual([
      { name: 'advance_requests_complete', deferrable: true, deferred: true },
      { name: 'consents_purge_requires_request_purge', deferrable: true, deferred: true },
      { name: 'invoice_installments_complete', deferrable: true, deferred: true },
      {
        name: 'invoice_installments_purge_requires_invoice_purge',
        deferrable: true,
        deferred: true,
      },
      { name: 'invoices_complete', deferrable: true, deferred: true },
      { name: 'invoices_purge_requires_request_purge', deferrable: true, deferred: true },
      { name: 'status_history_purge_requires_request_purge', deferrable: true, deferred: true },
    ])
    // El gate de las cuotas, en cambio, corre al terminar cada sentencia (AFTER ROW) y nunca se
    // posterga: no es un constraint trigger, así que ni DEFERRABLE ni SET CONSTRAINTS lo llevan al
    // COMMIT. Su función es VOLATILE: en READ COMMITTED su consulta toma una foto nueva y ve la
    // factura que otra transacción confirmó mientras la sentencia corría.
    const [gate] = await queryRows<{
      per_row: boolean
      constraint_trigger: boolean
      deferrable: boolean
    }>(`
      SELECT (tgtype & 1) = 1 AS per_row, tgconstraint <> 0 AS constraint_trigger,
             tgdeferrable AS deferrable
      FROM pg_trigger WHERE tgname = 'invoice_installments_same_transaction'`)
    expect(gate).toEqual({ per_row: true, constraint_trigger: false, deferrable: false })
    expect(volatility.invoice_installments_same_transaction).toBe('v')
  })

  // Una función PL/pgSQL resuelve los nombres de su cuerpo al correr, con el search_path vigente; sin
  // uno propio, una tabla temporal con el nombre de la tabla que lee un trigger la tapa (ver en (i)
  // los tests de tablas temporales). Toda función de la base que no sea de una extensión fija
  // search_path = pg_catalog, public, pg_temp: nombrar pg_temp, y al final, es lo único que evita que
  // se busque primero (`pg_catalog, public` solo no basta). Las funciones SQL con cuerpo estándar
  // (RETURN) guardan sus nombres ya resueltos al crearse y no lo necesitan. Un CREATE OR REPLACE sin el
  // SET borra el search_path fijado: este test lo detecta, sea cual sea la función.
  it('(d) toda función de la base fija su search_path con pg_temp al final (D49)', async () => {
    const functions = await queryRows<{
      name: string
      language: string
      standard_body: boolean
      config: string[] | null
    }>(`
      SELECT p.proname AS name, l.lanname AS language, p.prosqlbody IS NOT NULL AS standard_body,
             p.proconfig AS config
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang
      WHERE n.nspname = 'public'
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
          WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
        )`)
    const pinned = (config: string[] | null) =>
      config?.length === 1 && config[0] === 'search_path=pg_catalog, public, pg_temp'
    expect(
      functions
        .filter((f) => !(f.language === 'sql' && f.standard_body) && !pinned(f.config))
        .map((f) => `${f.name} (${f.language}): ${f.config?.join('; ') ?? 'sin search_path'}`),
    ).toEqual([])
    // La consulta sí ve las funciones de los triggers (todas PL/pgSQL, ninguna de una extensión).
    expect(functions.filter((f) => f.language === 'plpgsql').map((f) => f.name)).toEqual(
      expect.arrayContaining([
        'invoice_installments_same_transaction',
        'assert_advance_request_complete',
        'advance_requests_guard',
        'invoices_purge_requires_request_purge',
      ]),
    )
  })
})

describe('(e) cada CHECK rechaza la fila que la rompe', () => {
  it.each(Object.keys(BASE))('la fila base de %s cumple todas sus CHECK', async (table) => {
    const error = await sqlError((client) => insert(client, table, BASE[table]?.() ?? {}))
    expect([undefined, '23503']).toContain(error?.code)
  })

  it.each(CHECK_CASES)('$constraint', async ({ constraint, table, row, disableTrigger }) => {
    const error = await sqlError(async (client) => {
      if (disableTrigger)
        await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${disableTrigger}`)
      await insert(client, table, { ...BASE[table]?.(), ...row })
    })
    expect({ code: error?.code, constraint: error?.constraint }).toEqual({
      code: '23514',
      constraint,
    })
  })
})

describe('reglas espejo de shared', () => {
  const digits = (length: number) =>
    fc.string({ unit: fc.constantFrom(...'0123456789'), minLength: length, maxLength: length })

  it('(f) is_valid_ruc coincide con isValidRuc en 5000 casos', async () => {
    const candidates = fc.oneof(
      {
        weight: 4,
        arbitrary: fc
          .tuple(fc.constantFrom('10', '15', '16', '17', '20'), digits(9))
          .map(([a, b]) => a + b),
      },
      { weight: 2, arbitrary: digits(11) },
      { weight: 1, arbitrary: fc.string({ unit: 'grapheme', maxLength: 13 }) },
    )
    const values = fc
      .sample(candidates, { numRuns: 5000, seed: 20260925 })
      .filter((value) => !value.includes('\u0000'))
    const rows = await queryRows<{ valid: boolean }>(
      'SELECT is_valid_ruc(v) AS valid FROM unnest($1::text[]) WITH ORDINALITY AS t(v, n) ORDER BY n',
      [values],
    )
    const expected = values.map((value) => isValidRuc(value))
    expect(rows.map((row) => row.valid)).toEqual(expected)
    expect(expected.filter(Boolean).length).toBeGreaterThan(200)
  })

  it('(f) canonical_invoice_key coincide con invoiceKey en 5000 casos', async () => {
    const seriesNumber = fc
      .tuple(
        fc.string({
          unit: fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'),
          minLength: 4,
          maxLength: 4,
        }),
        fc.integer({ min: 1, max: 8 }).chain((length) => digits(length)),
      )
      .map(([series, number]) => `${series}-${number}`)
    const invoices = fc.sample(fc.tuple(digits(11), seriesNumber), {
      numRuns: 5000,
      seed: 20260925,
    })
    const rows = await queryRows<{ key: string }>(
      'SELECT canonical_invoice_key(r, s) AS key FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS t(r, s, n) ORDER BY n',
      [invoices.map(([ruc]) => ruc), invoices.map(([, series]) => series)],
    )
    expect(rows.map((row) => row.key)).toEqual(
      invoices.map(([issuerRuc, series]) => invoiceKey({ issuerRuc, seriesNumber: series })),
    )
  })

  // Zod 4 mide `.min()`/`.max()` en puntos de código Unicode (no en unidades UTF-16, como medía el
  // js_length que integrity_hardening eliminó): char_length() de PostgreSQL ya cuenta puntos de
  // código, así que las CHECK que antes llamaban a js_length ahora lo usan directamente. Los dos
  // tests de abajo prueban la CHECK real de la tabla (un INSERT dentro de una transacción que
  // siempre se deshace, con SAVEPOINT por fila para no pagar un BEGIN/ROLLBACK por caso), nunca una
  // copia de su expresión: si la CHECK real se desincroniza de publicPayerSchema, esto lo detecta.
  // Cruzan cada frontera (2, 3, 40 y 200 puntos de código, y 2000 en un texto) con caracteres
  // astrales y los 25 espacios que reconoce js_trim (`size: 'max'`: sin eso, fast-check 4.10.2 no
  // genera cadenas de más de 10 caracteres y ninguna frontera se cruza), e incluyen los
  // contraejemplos del hallazgo: 'a'.repeat(199)+'😀' (200 puntos de código, 201 unidades UTF-16) y
  // 1500 emoji en un texto (1500 puntos de código, 3000 unidades UTF-16).
  const jsWhitespace = [
    String.fromCharCode(0x0009), // tabulacion
    String.fromCharCode(0x000a), // salto de linea (LF)
    String.fromCharCode(0x000b), // tabulacion vertical
    String.fromCharCode(0x000c), // salto de pagina
    String.fromCharCode(0x000d), // retorno de carro (CR)
    String.fromCharCode(0x0020), // espacio
    String.fromCharCode(0x00a0), // espacio de no separacion (NBSP)
    String.fromCharCode(0x1680), // espacio ogham
    String.fromCharCode(0x2000), // espacio en cuadratin
    String.fromCharCode(0x2001), // espacio em cuadratin
    String.fromCharCode(0x2002), // espacio en
    String.fromCharCode(0x2003), // espacio em
    String.fromCharCode(0x2004), // espacio de tres por em
    String.fromCharCode(0x2005), // espacio de cuatro por em
    String.fromCharCode(0x2006), // espacio de seis por em
    String.fromCharCode(0x2007), // espacio de cifra
    String.fromCharCode(0x2008), // espacio de puntuacion
    String.fromCharCode(0x2009), // espacio fino
    String.fromCharCode(0x200a), // espacio de cabello
    String.fromCharCode(0x2028), // separador de linea
    String.fromCharCode(0x2029), // separador de parrafo
    String.fromCharCode(0x202f), // espacio fino de no separacion
    String.fromCharCode(0x205f), // espacio matematico medio
    String.fromCharCode(0x3000), // espacio ideografico
    String.fromCharCode(0xfeff), // BOM / ancho cero sin separacion
  ]
  const astralChars = ['😀', '🚀', '𝔘', '🧪', '🎉', '𠀀']
  const lengthMirrorUnit = fc.oneof(
    {
      weight: 6,
      arbitrary: fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ',
      ),
    },
    { weight: 2, arbitrary: fc.constantFrom(...jsWhitespace) },
    { weight: 2, arbitrary: fc.constantFrom(...astralChars) },
  )
  const basePayer = {
    slug: 'sea',
    ruc: '20131312955',
    legalName: 'Pagador válido',
    shortName: 'SEA',
    advancePercent: 80,
    minTermDays: 15,
    maxInvoices: 10,
    allowedCurrencies: ['PEN'],
    accentColor: '#0E7C86',
    logoUrl: null,
    texts: {},
  }
  /**
   * `text` con unos pocos de los espacios de js_trim a los lados (no los 25: con contenido cerca
   * de un límite, 25 a cada lado desbordaría el VARCHAR de la columna antes de llegar a la CHECK;
   * ver la nota de `probePayerChecks`). Los 25 igual se generan como candidatos sueltos vía
   * `lengthMirrorUnit`.
   */
  const padded = (text: string) =>
    `${jsWhitespace[0]}${jsWhitespace[6]}${jsWhitespace[23]}${text}${jsWhitespace[24]}${jsWhitespace[17]}${jsWhitespace[5]}`
  const codePointLength = (text: string) => [...text].length

  /**
   * Prueba cada patch de `payers` contra su CHECK real: un INSERT por fila, con SAVEPOINT, dentro
   * de una única transacción que nunca se confirma (ROLLBACK TO SAVEPOINT tras cada fila, y
   * ROLLBACK de todo al final). Mucho más barato que abrir una transacción por fila y, a
   * diferencia de evaluar la expresión aparte, prueba la restricción real de la tabla.
   */
  async function probePayerChecks(
    patches: readonly Row[],
  ): Promise<{ accepted: boolean; constraint?: string | undefined }[]> {
    const client = await pool.connect()
    const results: { accepted: boolean; constraint?: string | undefined }[] = []
    try {
      await client.query('BEGIN')
      for (const patch of patches) {
        await client.query('SAVEPOINT probe')
        try {
          await insert(client, 'payers', { ...BASE.payers?.(), ...patch })
          results.push({ accepted: true })
        } catch (error) {
          results.push({ accepted: false, constraint: (error as SqlError).constraint })
        } finally {
          await client.query('ROLLBACK TO SAVEPOINT probe')
        }
      }
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
    return results
  }

  /**
   * Para un valor cuyo largo *sin recortar* ya supera `max` (sin espacios que quitar, como
   * 'a'.repeat(201)), `legal_name`/`short_name` son `VARCHAR(max)`: PostgreSQL lo rechaza por el
   * tipo de la columna (22001) antes de llegar a la CHECK, que nunca corre. Para cualquier otro
   * valor, la única causa posible de rechazo es la CHECK misma.
   */
  function expectRealCheck(
    results: readonly { accepted: boolean; constraint?: string | undefined }[],
    values: readonly string[],
    max: number,
    checkName: string,
  ): void {
    for (const [i, result] of results.entries()) {
      if (result.accepted) continue
      const value = values[i] ?? ''
      const expectedConstraint = codePointLength(value) > max ? undefined : checkName
      expect(result.constraint, `#${i} ${JSON.stringify(value).slice(0, 40)}`).toBe(
        expectedConstraint,
      )
    }
  }

  it('(f) legalName y shortName miden puntos de código como publicPayerSchema, contra la CHECK real', async () => {
    const legalNameBoundary = [
      '',
      'a',
      'ab',
      'abc',
      'abcd',
      'A😀', // 2 puntos de código: Zod lo rechaza; la CHECK vieja (UTF-16) lo aceptaba
      'a'.repeat(199),
      'a'.repeat(200),
      'a'.repeat(201),
      `${'a'.repeat(199)}😀`, // 200 puntos de código (201 unidades UTF-16): contraejemplo del hallazgo
      `${'a'.repeat(200)}😀`,
      padded('abc'),
      padded('a'.repeat(190)), // 6 de relleno + 190 = 196, dentro de VARCHAR(200)
    ]
    const shortNameBoundary = [
      '',
      'a',
      'ab',
      'a😀', // 2 puntos de código, con astral
      'a'.repeat(39),
      'a'.repeat(40),
      'a'.repeat(41),
      `${'a'.repeat(39)}😀`, // 40 puntos de código (41 unidades UTF-16)
      `${'a'.repeat(40)}😀`,
      padded('ab'),
      padded('a'.repeat(30)), // 6 de relleno + 30 = 36, dentro de VARCHAR(40)
    ]
    // Hasta 40: cabe en las dos columnas (payers_short_name VARCHAR(40) incluido) sin desbordar
    // nunca el tipo, así que cada rechazo solo puede venir de la CHECK.
    const sharedRandomValues = fc
      .sample(fc.string({ unit: lengthMirrorUnit, minLength: 0, maxLength: 40, size: 'max' }), {
        numRuns: 400,
        seed: 20260925,
      })
      .filter((value) => !value.includes('\u0000'))
    // Hasta 200: cobertura ancha extra solo para legalName (su propio VARCHAR(200); no se usa
    // contra shortName, que desbordaría VARCHAR(40) antes de llegar a su CHECK).
    const legalNameWideValues = fc
      .sample(fc.string({ unit: lengthMirrorUnit, minLength: 0, maxLength: 200, size: 'max' }), {
        numRuns: 300,
        seed: 20260926,
      })
      .filter((value) => !value.includes('\u0000'))

    const legalNameValues = [...legalNameBoundary, ...sharedRandomValues, ...legalNameWideValues]
    const legalNameExpected = legalNameValues.map(
      (value) => publicPayerSchema.safeParse({ ...basePayer, legalName: value }).success,
    )
    const legalNameResults = await probePayerChecks(
      legalNameValues.map((value) => ({ legal_name: value })),
    )
    expect(legalNameResults.map((r) => r.accepted)).toEqual(legalNameExpected)
    expectRealCheck(legalNameResults, legalNameValues, 200, 'payers_legal_name_check')
    expect(legalNameExpected.some(Boolean)).toBe(true)
    expect(legalNameExpected.some((ok) => !ok)).toBe(true)

    const shortNameValues = [...shortNameBoundary, ...sharedRandomValues]
    const shortNameExpected = shortNameValues.map(
      (value) => publicPayerSchema.safeParse({ ...basePayer, shortName: value }).success,
    )
    const shortNameResults = await probePayerChecks(
      shortNameValues.map((value) => ({ short_name: value })),
    )
    expect(shortNameResults.map((r) => r.accepted)).toEqual(shortNameExpected)
    expectRealCheck(shortNameResults, shortNameValues, 40, 'payers_short_name_check')
    expect(shortNameExpected.some(Boolean)).toBe(true)
    expect(shortNameExpected.some((ok) => !ok)).toBe(true)
  })

  it('(f) el valor de un texto de payers mide puntos de código como publicPayerSchema, contra la CHECK real', async () => {
    // texts es jsonb, sin el VARCHAR de legal_name/short_name: no hay tope aparte que confundir
    // con la CHECK, así que aquí sí se prueba con relleno de los 25 espacios a la vez.
    const paddedWide = (text: string) => `${jsWhitespace.join('')}${text}${jsWhitespace.join('')}`
    const textsBoundary = [
      '',
      'a'.repeat(1999),
      'a'.repeat(2000),
      'a'.repeat(2001),
      `${'a'.repeat(1999)}😀`, // 2000 puntos de código (2001 unidades UTF-16)
      `${'a'.repeat(2000)}😀`,
      '😀'.repeat(1500), // contraejemplo del hallazgo: 1500 puntos de código, 3000 unidades UTF-16
      paddedWide('a'.repeat(2000)),
    ]
    const randomValues = fc
      .sample(fc.string({ unit: lengthMirrorUnit, minLength: 0, maxLength: 2010, size: 'max' }), {
        numRuns: 300,
        seed: 20260925,
      })
      .filter((value) => !value.includes('\u0000'))
    const values = [...textsBoundary, ...randomValues]

    const expected = values.map(
      (value) => publicPayerSchema.safeParse({ ...basePayer, texts: { title: value } }).success,
    )
    const results = await probePayerChecks(values.map((value) => ({ texts: { title: value } })))
    expect(results.map((r) => r.accepted)).toEqual(expected)
    expect(results.every((r) => r.accepted || r.constraint === 'payers_texts_check')).toBe(true)
    expect(expected.some(Boolean)).toBe(true)
    expect(expected.some((ok) => !ok)).toBe(true)
  })

  it('(g) transiciones y reglas de cierre de la base = TRANSITIONS y CLOSE_REASONS_BY_STATUS', async () => {
    const transitions = await queryRows<{
      from_status: string
      to_status: string
      min_role: string
    }>('SELECT from_status, to_status, min_role FROM advance_request_transitions')
    const byKey = (
      a: { from_status: string; to_status: string },
      b: { from_status: string; to_status: string },
    ) => `${a.from_status}>${a.to_status}`.localeCompare(`${b.from_status}>${b.to_status}`)
    expect(transitions.sort(byKey)).toEqual(
      TRANSITIONS.map((t) => ({
        from_status: t.from,
        to_status: t.to,
        min_role: t.minRole ?? 'AGENT',
      })).sort(byKey),
    )

    const rules = await queryRows<{ status: string; reason: string }>(
      'SELECT status, reason FROM close_reason_rules',
    )
    const asText = (list: { status: string; reason: string }[]) =>
      list.map((r) => `${r.status}:${r.reason}`).sort()
    expect(asText(rules)).toEqual(
      asText(
        Object.entries(CLOSE_REASONS_BY_STATUS).flatMap(([status, reasons]) =>
          reasons.map((reason) => ({ status, reason })),
        ),
      ),
    )
  })
})

describe('comportamiento de los triggers', () => {
  const move = (id: string, status: string, extra = '') =>
    pool.query(
      `UPDATE advance_requests SET status = $2, version = version + 1${extra} WHERE id = $1`,
      [id, status],
    )

  it('(h) WITHDRAWN libera las facturas de la solicitud y DISBURSED las deja bloqueadas', async () => {
    const first = await createCompleteAdvanceRequest(db.prisma, {
      invoices: [{ seriesNumber: 'F001-00000077' }],
    })
    await expect(
      createCompleteAdvanceRequest(db.prisma, { invoices: [{ seriesNumber: 'F001-77' }] }),
    ).rejects.toMatchObject({
      code: 'P2002',
      meta: {
        driverAdapterError: { cause: { constraint: { index: 'invoices_open_invoice_key_key' } } },
      },
    })

    await move(first.id, 'WITHDRAWN', ", close_reason = 'SUPPLIER_WITHDREW', closed_at = now()")
    const [invoice] = await queryRows<{ request_status: string }>(
      'SELECT request_status FROM invoices WHERE id = $1',
      [first.invoices[0]?.id],
    )
    expect(invoice).toEqual({ request_status: 'WITHDRAWN' })

    const second = await createCompleteAdvanceRequest(db.prisma, {
      invoices: [{ seriesNumber: 'F001-77' }],
    })
    for (const status of [
      'CONTACTED',
      'DOCUMENTS_PENDING',
      'UNDER_REVIEW',
      'QUOTE_SENT',
      'APPROVED',
    ]) {
      await move(second.id, status)
    }
    await move(second.id, 'DISBURSED', ', closed_at = now()')
    await expect(
      createCompleteAdvanceRequest(db.prisma, { invoices: [{ seriesNumber: 'F001-0077' }] }),
    ).rejects.toMatchObject({ code: 'P2002' })
  })

  it('(i) status_history y audit_logs son de solo inserción; la purga por retención sí borra', async () => {
    const request = await createCompleteAdvanceRequest(db.prisma)
    await pool.query(
      "INSERT INTO audit_logs (action, entity) VALUES ('advance-request.viewed', 'advance_request')",
    )

    for (const [sql, constraint] of [
      [
        "UPDATE status_history SET correlation_id = 'otro' WHERE advance_request_id = $1",
        'status_history_append_only',
      ],
      ['DELETE FROM status_history WHERE advance_request_id = $1', 'status_history_append_only'],
      [
        "UPDATE audit_logs SET action = 'otro' WHERE $1::uuid IS NOT NULL",
        'audit_logs_append_only',
      ],
      ['DELETE FROM audit_logs WHERE $1::uuid IS NOT NULL', 'audit_logs_append_only'],
    ] as const) {
      expect((await updateError(sql, [request.id]))?.constraint, sql).toBe(constraint)
    }
    const purge = await sqlError(async (client) => {
      await client.query("SET LOCAL app.retention_purge = 'on'")
      await client.query('DELETE FROM audit_logs')
    })
    expect(purge).toBeNull()
  })

  it('(i) de un consentimiento solo cambia revoked_at, y una sola vez', async () => {
    const request = await createCompleteAdvanceRequest(db.prisma)
    const revoke =
      "UPDATE consents SET revoked_at = now() WHERE advance_request_id = $1 AND type = 'TERMS'"
    expect(
      await updateError(
        "UPDATE consents SET document_version = 'otra' WHERE advance_request_id = $1",
        [request.id],
      ),
    ).toMatchObject({ constraint: 'consents_append_only' })
    expect(
      await updateError('DELETE FROM consents WHERE advance_request_id = $1', [request.id]),
    ).toMatchObject({
      constraint: 'consents_append_only',
    })
    await pool.query(revoke, [request.id])
    expect(await updateError(revoke, [request.id])).toMatchObject({
      constraint: 'consents_append_only',
    })
  })

  it('(i) la solicitud: identidad inmutable, versión + 1, transición válida y updated_at de la base', async () => {
    const request = await createCompleteAdvanceRequest(db.prisma)
    const cases = [
      [
        'UPDATE advance_requests SET requested_amount = requested_amount - 1, version = version + 1 WHERE id = $1',
        'advance_requests_identity_immutable',
      ],
      [
        "UPDATE advance_requests SET public_code = 'ANT-2026-999999', version = version + 1 WHERE id = $1",
        'advance_requests_identity_immutable',
      ],
      [
        "UPDATE advance_requests SET status = 'CONTACTED' WHERE id = $1",
        'advance_requests_version_increment',
      ],
      [
        "UPDATE advance_requests SET status = 'CONTACTED', version = version + 2 WHERE id = $1",
        'advance_requests_version_increment',
      ],
      [
        "UPDATE advance_requests SET status = 'APPROVED', version = version + 1 WHERE id = $1",
        'advance_requests_transition_allowed',
      ],
    ] as const
    for (const [sql, constraint] of cases) {
      expect((await updateError(sql, [request.id]))?.constraint, sql).toBe(constraint)
    }
    await pool.query(
      "UPDATE advance_requests SET status = 'CONTACTED', version = version + 1, updated_at = '2000-01-01T00:00:00Z' WHERE id = $1",
      [request.id],
    )
    const [row] = await queryRows<{ status: string; version: number; stale: boolean }>(
      "SELECT status, version, updated_at < '2001-01-01' AS stale FROM advance_requests WHERE id = $1",
      [request.id],
    )
    expect(row).toEqual({ status: 'CONTACTED', version: 2, stale: false })
  })

  it('(i) facturas y archivos: solo cambia lo que su ciclo de vida permite', async () => {
    const request = await createCompleteAdvanceRequest(db.prisma)
    const fileId = request.fileIds[0]
    expect(
      await updateError('UPDATE invoices SET total = total + 1 WHERE advance_request_id = $1', [
        request.id,
      ]),
    ).toMatchObject({ constraint: 'invoices_immutable' })
    expect(
      await updateError("UPDATE stored_files SET sha256 = repeat('0', 64) WHERE id = $1", [fileId]),
    ).toMatchObject({
      constraint: 'stored_files_identity_immutable',
    })
    expect(
      await updateError(
        "UPDATE stored_files SET status = 'PENDING', attached_at = NULL WHERE id = $1",
        [fileId],
      ),
    ).toMatchObject({ constraint: 'stored_files_status_transition' })
    await pool.query(
      "UPDATE stored_files SET status = 'DELETED', deleted_at = now(), purge_after = now() + interval '35 days' WHERE id = $1",
      [fileId],
    )
    await pool.query('UPDATE stored_files SET purged_at = now() WHERE id = $1', [fileId])
    expect(
      await updateError(
        "UPDATE stored_files SET purged_at = now() + interval '1 day' WHERE id = $1",
        [fileId],
      ),
    ).toMatchObject({ constraint: 'stored_files_purged_at_immutable' })
    expect(
      await updateError("UPDATE stored_files SET status = 'ATTACHED' WHERE id = $1", [fileId]),
    ).toMatchObject({
      constraint: 'stored_files_status_transition',
    })
  })

  it('(i) outbox: identidad inmutable, PUBLISHED no cambia y solo se borra lo publicado', async () => {
    const request = await createCompleteAdvanceRequest(db.prisma)
    const eventId = newId()
    await pool.query(
      `INSERT INTO outbox_events (id, handler, dedupe_key, event_type, payload, advance_request_id, max_attempts)
       VALUES ($1, 'email.team-alert', $2, 'advance-request.created', $3, $4, 5)`,
      [
        eventId,
        `email.team-alert:${request.id}`,
        JSON.stringify({ id: eventId, type: 'advance-request.created', version: 1 }),
        request.id,
      ],
    )
    expect(await updateError('DELETE FROM outbox_events WHERE id = $1', [eventId])).toMatchObject({
      constraint: 'outbox_events_delete_published_only',
    })
    expect(
      await updateError("UPDATE outbox_events SET handler = 'email.otro' WHERE id = $1", [eventId]),
    ).toMatchObject({
      constraint: 'outbox_events_identity_immutable',
    })
    await pool.query(
      "UPDATE outbox_events SET status = 'PUBLISHED', published_at = now() WHERE id = $1",
      [eventId],
    )
    expect(
      await updateError(
        "UPDATE outbox_events SET status = 'PENDING', published_at = NULL WHERE id = $1",
        [eventId],
      ),
    ).toMatchObject({ constraint: 'outbox_events_published_immutable' })
    await pool.query('DELETE FROM outbox_events WHERE id = $1', [eventId])
  })

  it('(i) la base rechaza al confirmar una solicitud incompleta', async () => {
    const complete = await createCompleteAdvanceRequest(db.prisma)
    const alone = await sqlError(
      (client) =>
        insert(client, 'advance_requests', {
          ...BASE.advance_requests?.(),
          payer_id: complete.payerId,
          payer_ruc: complete.payerRuc,
          supplier_id: complete.supplierId,
          supplier_ruc: complete.supplierRuc,
        }),
      'COMMIT',
    )
    expect(alone).toMatchObject({ constraint: 'advance_requests_complete' })

    // Por Prisma, el error del COMMIT llega como DriverAdapterError con el código y el mensaje de PostgreSQL.
    for (const [part, message] of [
      ['invoices', /no tiene facturas/],
      ['consents', /no tiene los dos consentimientos/],
      ['initialHistory', /no tiene su historial inicial/],
    ] as const) {
      await expect(
        createCompleteAdvanceRequest(db.prisma, { omit: [part] }),
        part,
      ).rejects.toMatchObject({
        cause: { code: '23000', message: expect.stringMatching(message) },
      })
    }
    const [count] = await queryRows<{ total: number }>(
      'SELECT count(*)::int AS total FROM advance_requests',
    )
    expect(count).toEqual({ total: 1 })
  })

  // D49: el agregado ya confirmado solo se protegía al crearlo. Estos cuatro casos son los caminos
  // que quedaban abiertos para dejarlo en un estado imposible o liberar la clave de una factura ya
  // desembolsada (doble financiamiento) sin pasar por ninguna CHECK.
  it('(i) una factura no se borra fuera de la purga por retención (D49)', async () => {
    const request = await createCompleteAdvanceRequest(db.prisma)
    expect(
      await updateError('DELETE FROM invoices WHERE id = $1', [request.invoices[0]?.id]),
    ).toMatchObject({ constraint: 'invoices_delete_restricted' })
  })

  it('(i) una cuota es de solo inserción fuera de la purga por retención (D49)', async () => {
    const request = await createCompleteAdvanceRequest(db.prisma)
    const invoiceId = request.invoices[0]?.id
    expect(
      await updateError("UPDATE invoice_installments SET label = 'Otra' WHERE invoice_id = $1", [
        invoiceId,
      ]),
    ).toMatchObject({ constraint: 'invoice_installments_append_only' })
    expect(
      await updateError('DELETE FROM invoice_installments WHERE invoice_id = $1', [invoiceId]),
    ).toMatchObject({ constraint: 'invoice_installments_append_only' })
  })

  // Con la purga encendida, borrar solo las facturas (sin borrar también la solicitud, en la misma
  // transacción) liberaba la clave de una factura de una solicitud DESEMBOLSADA: doble
  // financiamiento. El constraint trigger diferido de abajo exige que, si una factura se borra, su
  // solicitud se haya borrado también antes de confirmar.
  // Se confirma (antes terminaba en ROLLBACK y los constraint triggers diferidos de la purga nunca
  // llegaban a correr) y se comprueba que no quedó ninguna fila del agregado.
  it('(i) purgar el agregado completo en una transacción sí funciona (D49)', async () => {
    const request = await createCompleteAdvanceRequest(db.prisma)
    const invoiceIds = request.invoices.map((invoice) => invoice.id)
    expect(await aggregateLeftovers(request.id, invoiceIds, request.fileIds)).toEqual({
      advance_requests: 1,
      invoices: 1,
      invoice_installments: 1,
      consents: 2,
      status_history: 1,
      stored_files: 1,
    })

    expect(await purgeAggregate(request.id)).toBeNull()
    expect(await aggregateLeftovers(request.id, invoiceIds, request.fileIds)).toEqual({
      advance_requests: 0,
      invoices: 0,
      invoice_installments: 0,
      consents: 0,
      status_history: 0,
      stored_files: 0,
    })
  })

  it('(i) purgar solo las facturas sin la solicitud se rechaza al confirmar (D49)', async () => {
    const request = await createCompleteAdvanceRequest(db.prisma)
    const error = await sqlError(async (client) => {
      await client.query("SET LOCAL app.retention_purge = 'on'")
      await client.query(
        'DELETE FROM invoice_installments WHERE invoice_id IN (SELECT id FROM invoices WHERE advance_request_id = $1)',
        [request.id],
      )
      await client.query('DELETE FROM invoices WHERE advance_request_id = $1', [request.id])
      // La solicitud no se borra: su clave de factura quedaría libre con la solicitud todavía viva.
    }, 'COMMIT')
    expect(error).toMatchObject({ constraint: 'invoices_purge_requires_request_purge' })
  })

  // Mismo patrón para los hermanos de una factura o una solicitud viva: la purga por retención
  // dejaba borrar solo las cuotas de una factura, o solo un consentimiento o el historial de una
  // solicitud, sin borrar la factura o la solicitud dueña (reproducido: una solicitud DESEMBOLSADA
  // con 0 cuotas, 1 consentimiento o sin historial, y su factura o su solicitud intactas).
  it('(i) purgar solo las cuotas sin la factura se rechaza al confirmar (D49)', async () => {
    const request = await createCompleteAdvanceRequest(db.prisma)
    const error = await sqlError(async (client) => {
      await client.query("SET LOCAL app.retention_purge = 'on'")
      await client.query('DELETE FROM invoice_installments WHERE invoice_id = $1', [
        request.invoices[0]?.id,
      ])
      // La factura no se borra.
    }, 'COMMIT')
    expect(error).toMatchObject({ constraint: 'invoice_installments_purge_requires_invoice_purge' })
  })

  it('(i) purgar solo un consentimiento sin la solicitud se rechaza al confirmar (D49)', async () => {
    const request = await createCompleteAdvanceRequest(db.prisma)
    const error = await sqlError(async (client) => {
      await client.query("SET LOCAL app.retention_purge = 'on'")
      await client.query("DELETE FROM consents WHERE advance_request_id = $1 AND type = 'TERMS'", [
        request.id,
      ])
      // La solicitud no se borra.
    }, 'COMMIT')
    expect(error).toMatchObject({ constraint: 'consents_purge_requires_request_purge' })
  })

  it('(i) purgar solo el historial sin la solicitud se rechaza al confirmar (D49)', async () => {
    const request = await createCompleteAdvanceRequest(db.prisma)
    const error = await sqlError(async (client) => {
      await client.query("SET LOCAL app.retention_purge = 'on'")
      await client.query('DELETE FROM status_history WHERE advance_request_id = $1', [request.id])
      // La solicitud no se borra.
    }, 'COMMIT')
    expect(error).toMatchObject({ constraint: 'status_history_purge_requires_request_purge' })
  })

  // Una cuota que no movía earliest_due_date pasaba el trigger diferido de la ronda 1 sin más
  // (invoice_installments_complete solo compara el agregado final). El gate de abajo cierra el
  // camino de raíz: una cuota nunca se agrega fuera de la transacción que creó su factura, se mueva
  // o no earliest_due_date. Compara invoices.creating_xact_id (congelada al insertar la factura)
  // contra pg_current_xact_id(), nunca contra xmin: xmin es quien escribió la última versión de la
  // fila, no quien la creó, y dentro de un SAVEPOINT es el xid de la subtransacción mientras
  // pg_current_xact_id() sigue siendo el de la transacción de nivel superior (así corren los
  // `$transaction` anidados de Prisma). Es un trigger AFTER INSERT FOR EACH ROW, no diferido: corre
  // al terminar cada sentencia, y una factura que no ve en ese momento también es una violación
  // (integrity_hardening_4; ver la carrera de abajo).
  it('(i) una cuota solo se agrega en la misma transacción que creó su factura (D49)', async () => {
    // Camino feliz: crear la solicitud completa (factura + cuotas) en una única transacción, como
    // hace la API, sigue funcionando.
    const request = await createCompleteAdvanceRequest(db.prisma)
    expect(request.invoices[0]?.id).toBeDefined()

    // Ataque: una cuota nueva para esa misma factura, ya confirmada en otra transacción, se
    // rechaza al terminar la sentencia (no hace falta esperar a la confirmación).
    const error = await sqlError((client) =>
      client.query(
        `INSERT INTO invoice_installments (invoice_id, number, label, amount, due_date)
         VALUES ($1, 2, 'Cuota002', '100.00', '2026-10-01')`,
        [request.invoices[0]?.id],
      ),
    )
    expect(error).toMatchObject({ constraint: 'invoice_installments_same_transaction' })
  })

  // La carrera que dejaba pasar el gate cuando era BEFORE INSERT (reproducida en la revisión de la
  // ronda 3): en READ COMMITTED, la fila de B pasaba el trigger con la factura de A todavía sin
  // confirmar (invisible, así que no había creating_xact_id que comparar), A confirmaba antes de que
  // terminara la sentencia de B, la FK ya encontraba la factura y el trigger diferido del agregado no
  // suma cuotas: B confirmaba una cuota ajena sobre la factura de A (suma 10720.00 contra un neto de
  // 10620.00). Ahora el gate corre al terminar la sentencia y su consulta toma una foto nueva: ve la
  // factura de A con el creating_xact_id de A y la rechaza.
  it('(i) una cuota para la factura de otra transacción que confirma a mitad de la sentencia se rechaza (D49)', async () => {
    const seed = await createCompleteAdvanceRequest(db.prisma)
    const race = await raceForeignInstallment(seed, 'READ COMMITTED', 2026_0925_41)
    try {
      // B se rechaza, y A confirmó su agregado con la factura intacta: una sola cuota, por el neto.
      expect({
        code: race.error?.code,
        constraint: race.error?.constraint,
        installments: await installmentsOf(race.invoiceId),
      }).toEqual({
        code: '23000',
        constraint: 'invoice_installments_same_transaction',
        installments: [{ number: 1, amount: '10620.00' }],
      })
    } finally {
      expect(await purgeAggregate(race.requestId)).toBeNull()
    }
  })

  // En REPEATABLE READ la foto de B es la de su primera sentencia, cuando la factura de A todavía no
  // estaba confirmada. Hoy la rechaza la FK, que en este aislamiento consulta con esa misma foto y
  // corre antes que el gate (los triggers de una tabla corren por orden de nombre y los de la FK
  // empiezan con "RI_"); el gate la rechazaría igual, porque tampoco la ve (lo prueba el test
  // siguiente con la FK postergada). Cualquiera de las dos reglas vale: lo que importa es que B no
  // confirma nada sobre la factura de A.
  it('(i) en REPEATABLE READ la misma carrera también se rechaza (D49)', async () => {
    const seed = await createCompleteAdvanceRequest(db.prisma)
    const race = await raceForeignInstallment(seed, 'REPEATABLE READ', 2026_0925_42)
    try {
      expect([
        { code: '23503', constraint: 'invoice_installments_invoice_id_fkey' },
        { code: '23000', constraint: 'invoice_installments_same_transaction' },
      ]).toContainEqual({ code: race.error?.code, constraint: race.error?.constraint })
      expect(await installmentsOf(race.invoiceId)).toEqual([{ number: 1, amount: '10620.00' }])
    } finally {
      expect(await purgeAggregate(race.requestId)).toBeNull()
    }
  })

  // El gate no deja la factura inexistente o invisible en manos de la FK: si no la ve al terminar la
  // sentencia, rechaza él mismo. Para que sea lo único que corre al terminar la sentencia, la FK se
  // posterga dentro de una transacción que se deshace (DDL transaccional, como disableTrigger en (e)).
  it('(i) una cuota sin factura visible la rechaza el propio gate, sin depender de la FK (D49)', async () => {
    const error = await sqlError(async (client) => {
      await client.query(
        'ALTER TABLE invoice_installments ALTER CONSTRAINT invoice_installments_invoice_id_fkey DEFERRABLE INITIALLY DEFERRED',
      )
      await insert(client, 'invoice_installments', {
        ...BASE.invoice_installments?.(),
        invoice_id: newId(),
      })
    })
    expect(error).toMatchObject({
      code: '23000',
      constraint: 'invoice_installments_same_transaction',
    })
  })

  // xmin (la ronda 2) cambia con cualquier UPDATE, incluso uno sin cambios reales: invoices_guard
  // deja pasar un UPDATE que solo toca updated_at (lo excluye de su diff), así que un script podía
  // "tocar" la factura para que xmin volviera a coincidir con la transacción en curso y reabrir la
  // ventana para agregar una cuota. creating_xact_id nunca cambia después del INSERT (la congela
  // invoices_guard, como cualquier otra columna), así que el UPDATE sin cambios ya no ayuda.
  it('(i) tocar la factura con un UPDATE sin cambios no reabre la ventana para una cuota nueva (D49)', async () => {
    const request = await createCompleteAdvanceRequest(db.prisma)
    const invoiceId = request.invoices[0]?.id
    const error = await sqlError(async (client) => {
      await client.query('UPDATE invoices SET updated_at = updated_at WHERE id = $1', [invoiceId])
      await client.query(
        `INSERT INTO invoice_installments (invoice_id, number, label, amount, due_date)
         VALUES ($1, 2, 'Cuota002', '100.00', '2026-10-01')`,
        [invoiceId],
      )
    })
    expect(error).toMatchObject({ constraint: 'invoice_installments_same_transaction' })
  })

  // Mismo hueco de xmin, con el camino real por el que se abría: la FK de alcance con ON UPDATE
  // CASCADE copia el nuevo status de la solicitud al request_status de sus facturas en cada cambio
  // de estado, lo que también "toca" la factura (cambia su xmin) sin cambiar creating_xact_id.
  it('(i) un cambio de estado no reabre la ventana para una cuota nueva (D49)', async () => {
    const request = await createCompleteAdvanceRequest(db.prisma)
    const invoiceId = request.invoices[0]?.id
    const error = await sqlError(async (client) => {
      await client.query(
        "UPDATE advance_requests SET status = 'CONTACTED', version = version + 1 WHERE id = $1",
        [request.id],
      )
      await client.query(
        `INSERT INTO invoice_installments (invoice_id, number, label, amount, due_date)
         VALUES ($1, 2, 'Cuota002', '100.00', '2026-10-01')`,
        [invoiceId],
      )
    })
    expect(error).toMatchObject({ constraint: 'invoice_installments_same_transaction' })
  })

  // Prisma 7.10 corre los `$transaction` anidados como SAVEPOINT (`prisma_sp_N`) y un bloque
  // EXCEPTION de PL/pgSQL abre uno también: pg_current_xact_id() es el mismo antes y dentro del
  // SAVEPOINT (a diferencia de xmin, que ahí sí cambia a un xid de la subtransacción), así que
  // crear la factura y su cuota bajo un SAVEPOINT sigue aceptándose.
  it('(i) una factura y su cuota creadas bajo un SAVEPOINT en la misma transacción se aceptan (D49)', async () => {
    const seed = await createCompleteAdvanceRequest(db.prisma)
    const requestId = newId()
    const invoiceId = newId()
    const xmlFileId = newId()
    const error = await sqlError(async (client) => {
      await insert(client, 'stored_files', {
        id: xmlFileId,
        storage_bucket: 'anticipate-test',
        key: `savepoint/${xmlFileId}`,
        purpose: 'INVOICE_XML',
        content_type: 'application/xml',
        size_bytes: 1024,
        sha256: HEX_64,
        status: 'ATTACHED',
        attached_at: NOW,
      })
      await insert(client, 'advance_requests', {
        ...BASE.advance_requests?.(),
        id: requestId,
        payer_id: seed.payerId,
        payer_ruc: seed.payerRuc,
        supplier_id: seed.supplierId,
        supplier_ruc: seed.supplierRuc,
      })
      await client.query('SAVEPOINT prisma_sp_0')
      await insert(client, 'invoices', {
        ...BASE.invoices?.(),
        id: invoiceId,
        advance_request_id: requestId,
        issuer_ruc: seed.supplierRuc,
        recipient_ruc: seed.payerRuc,
        xml_file_id: xmlFileId,
      })
      await client.query(
        `INSERT INTO invoice_installments (invoice_id, number, label, amount, due_date)
         VALUES ($1, 1, 'Cuota001', '10620.00', '2026-11-30')`,
        [invoiceId],
      )
      await client.query('RELEASE SAVEPOINT prisma_sp_0')
      await insert(client, 'consents', {
        ...BASE.consents?.(),
        advance_request_id: requestId,
        type: 'TERMS',
      })
      await insert(client, 'consents', {
        ...BASE.consents?.(),
        advance_request_id: requestId,
        type: 'PERSONAL_DATA',
      })
      await insert(client, 'status_history', {
        ...BASE.status_history?.(),
        advance_request_id: requestId,
      })
    }, 'COMMIT')
    expect(error).toBeNull()
  })

  // Una sola sentencia con CTE que insertan la factura y sus cuotas juntas: las CTE comparten la foto
  // de la sentencia, así que un trigger BEFORE ROW de la cuota nunca veía la factura. El gate corre al
  // terminar la sentencia, cuando la factura ya se ve con el creating_xact_id de esta transacción.
  it('(i) un agregado creado en una sola sentencia con CTE que modifican datos se confirma (D49)', async () => {
    const seed = await createCompleteAdvanceRequest(db.prisma)
    const aggregate = aggregateRows(seed)
    const error = await sqlError((client) => insertInOneStatement(client, aggregate.rows), 'COMMIT')
    try {
      expect(error).toBeNull()
      expect(await installmentsOf(aggregate.invoiceId)).toEqual([{ number: 1, amount: '10620.00' }])
    } finally {
      expect(await purgeAggregate(aggregate.requestId)).toBeNull()
    }
  })

  // Un bloque PL/pgSQL con EXCEPTION corre en una subtransacción: pg_current_xact_id() sigue siendo el
  // de la transacción de nivel superior, igual que el creating_xact_id que recibió la factura.
  it('(i) un agregado creado dentro de un bloque PL/pgSQL con EXCEPTION se confirma (D49)', async () => {
    const seed = await createCompleteAdvanceRequest(db.prisma)
    const aggregate = aggregateRows(seed)
    const statements = aggregate.rows.map(([table, row]) => `${insertLiteral(table, row)};`)
    const error = await sqlError(
      (client) =>
        client.query(`DO $block$
          BEGIN
            ${statements.join('\n            ')}
          EXCEPTION WHEN unique_violation THEN
            RAISE;
          END
        $block$`),
      'COMMIT',
    )
    try {
      expect(error).toBeNull()
      expect(await installmentsOf(aggregate.invoiceId)).toEqual([{ number: 1, amount: '10620.00' }])
    } finally {
      expect(await purgeAggregate(aggregate.requestId)).toBeNull()
    }
  })

  it('(i) un creating_xact_id que venga del cliente al insertar la factura se ignora (D49)', async () => {
    const seed = await createCompleteAdvanceRequest(db.prisma)
    const invoiceId = newId()
    const xmlFileId = newId()
    const client = await pool.connect()
    let forced: boolean | undefined
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO stored_files (id, storage_bucket, key, purpose, content_type, size_bytes, sha256, status, attached_at)
         VALUES ($1, 'anticipate-test', $2, 'INVOICE_XML', 'application/xml', 1024, $3, 'ATTACHED', now())`,
        [xmlFileId, `client-value/${xmlFileId}`, HEX_64],
      )
      const result = await client.query<{ forced: boolean }>(
        `INSERT INTO invoices (
           id, advance_request_id, request_status, currency, issuer_ruc, recipient_ruc, document_type,
           series_number, invoice_key, issuer_name, payment_terms, total, net_pending_amount, issue_date,
           due_date, signed, xml_file_id, creating_xact_id
         ) VALUES (
           $1, $2, 'NEW', 'PEN', $3, $4, '01', 'F001-00000901', $6, 'Proveedor', 'CREDIT',
           '11800.00', '10620.00', '2026-09-01', '2026-11-30', true, $5, '999999999'::xid8
         ) RETURNING creating_xact_id = pg_current_xact_id() AS forced`,
        [
          invoiceId,
          seed.id,
          seed.supplierRuc,
          seed.payerRuc,
          xmlFileId,
          invoiceKey({ issuerRuc: seed.supplierRuc, seriesNumber: 'F001-00000901' }),
        ],
      )
      forced = result.rows[0]?.forced
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
    expect(forced).toBe(true)
  })

  it('(i) creating_xact_id de la factura no se puede modificar (D49)', async () => {
    const request = await createCompleteAdvanceRequest(db.prisma)
    expect(
      await updateError("UPDATE invoices SET creating_xact_id = '999999999' WHERE id = $1", [
        request.invoices[0]?.id,
      ]),
    ).toMatchObject({ constraint: 'invoices_immutable' })
  })

  // Con el gate ya cerrado de raíz, se puede volver a probar el trigger diferido de la ronda 1 sin
  // que lo tape una transacción anterior: una cuota de la MISMA transacción que su factura, pero
  // que adelanta la fecha más próxima antes de lo que la solicitud declaró, se rechaza al confirmar.
  it('(i) una cuota que adelanta earliest_due_date en la misma transacción rompe el agregado y se rechaza al confirmar (D49)', async () => {
    const seed = await createCompleteAdvanceRequest(db.prisma)
    const requestId = newId()
    const invoiceId = newId()
    const xmlFileId = newId()
    const error = await sqlError(async (client) => {
      await insert(client, 'stored_files', {
        id: xmlFileId,
        storage_bucket: 'anticipate-test',
        key: `earliest/${xmlFileId}`,
        purpose: 'INVOICE_XML',
        content_type: 'application/xml',
        size_bytes: 1024,
        sha256: HEX_64,
        status: 'ATTACHED',
        attached_at: NOW,
      })
      // earliest_due_date declarado: 2026-11-30 (por defecto de BASE.advance_requests).
      await insert(client, 'advance_requests', {
        ...BASE.advance_requests?.(),
        id: requestId,
        payer_id: seed.payerId,
        payer_ruc: seed.payerRuc,
        supplier_id: seed.supplierId,
        supplier_ruc: seed.supplierRuc,
      })
      await insert(client, 'invoices', {
        ...BASE.invoices?.(),
        id: invoiceId,
        advance_request_id: requestId,
        issuer_ruc: seed.supplierRuc,
        recipient_ruc: seed.payerRuc,
        xml_file_id: xmlFileId,
      })
      // Mismo neto (10620.00) repartido en dos cuotas, pero la primera vence antes de lo declarado.
      await client.query(
        `INSERT INTO invoice_installments (invoice_id, number, label, amount, due_date) VALUES
         ($1, 1, 'Cuota001', '5000.00', '2026-10-01'),
         ($1, 2, 'Cuota002', '5620.00', '2026-11-30')`,
        [invoiceId],
      )
      await insert(client, 'consents', {
        ...BASE.consents?.(),
        advance_request_id: requestId,
        type: 'TERMS',
      })
      await insert(client, 'consents', {
        ...BASE.consents?.(),
        advance_request_id: requestId,
        type: 'PERSONAL_DATA',
      })
      await insert(client, 'status_history', {
        ...BASE.status_history?.(),
        advance_request_id: requestId,
      })
    }, 'COMMIT')
    expect(error).toMatchObject({ constraint: 'advance_requests_complete' })
  })

  it('(i) una factura nueva en una solicitud existente rompe el conteo y se rechaza al confirmar (D49)', async () => {
    const request = await createCompleteAdvanceRequest(db.prisma)
    const error = await sqlError(async (client) => {
      const fileId = newId()
      await insert(client, 'stored_files', {
        id: fileId,
        storage_bucket: 'anticipate-test',
        key: `extra/${fileId}`,
        purpose: 'INVOICE_XML',
        content_type: 'application/xml',
        size_bytes: 1024,
        sha256: HEX_64,
        status: 'ATTACHED',
        attached_at: NOW,
      })
      await insert(client, 'invoices', {
        ...BASE.invoices?.(),
        advance_request_id: request.id,
        issuer_ruc: request.supplierRuc,
        recipient_ruc: request.payerRuc,
        series_number: 'F001-00000999',
        invoice_key: `${request.supplierRuc}|F001-999`,
        xml_file_id: fileId,
      })
    }, 'COMMIT')
    expect(error).toMatchObject({ constraint: 'advance_requests_complete' })
  })

  // Las funciones de los triggers nombran las tablas sin esquema (`FROM invoices i`), y hasta
  // pin_function_search_path no fijaban su search_path: una sesión con TEMP (PUBLIC lo tiene por
  // defecto) tapaba la tabla que lee un trigger con una tabla temporal del mismo nombre y filas
  // falsas, y el trigger leía esas filas. La FK no se enteraba: sus consultas nombran
  // public.<tabla>. Reproducido en la revisión de integrity_hardening_4, también como un rol sin
  // superusuario, con solo SELECT e INSERT: una cuota ajena confirmada sobre una factura ya confirmada
  // (suma 10720.00 contra un neto de 10620.00) y una segunda factura en una solicitud que declara una.
  // Estos cuatro casos cubren cada forma de regla (el gate, el agregado diferido, la máquina de estados
  // y la purga); el test estructural (d) exige el search_path fijo en todas las funciones.
  it('(i) una tabla temporal llamada invoices no abre el gate de las cuotas (D49)', async () => {
    const request = await createCompleteAdvanceRequest(db.prisma)
    const invoiceId = onlyInvoiceId(request)
    const { shadowed, error } = await commitWithShadowTable(
      'invoices',
      async (client) => {
        // La factura falsa dice que la creó esta transacción y que no es de ninguna solicitud (así
        // el trigger diferido de las cuotas tampoco tiene un agregado que revisar).
        await client.query(
          'CREATE TEMP TABLE invoices (id uuid, creating_xact_id xid8, advance_request_id uuid) ON COMMIT DROP',
        )
        await client.query('INSERT INTO pg_temp.invoices VALUES ($1, pg_current_xact_id(), NULL)', [
          invoiceId,
        ])
      },
      (client) =>
        client.query(
          `INSERT INTO invoice_installments (invoice_id, number, label, amount, due_date)
           VALUES ($1, 2, 'Cuota002', '100.00', '2026-12-15')`,
          [invoiceId],
        ),
    )
    expect({
      shadowed,
      code: error?.code,
      constraint: error?.constraint,
      installments: await installmentsOf(invoiceId),
    }).toEqual({
      shadowed: true,
      code: '23000',
      constraint: 'invoice_installments_same_transaction',
      installments: [{ number: 1, amount: '10620.00' }],
    })
  })

  it('(i) una tabla temporal llamada advance_requests no deja agregar una factura a una solicitud confirmada (D49)', async () => {
    const request = await createCompleteAdvanceRequest(db.prisma)
    const fileId = newId()
    // La fábrica solo usa la serie F001: esta factura nunca choca con la de la solicitud.
    const seriesNumber = 'F002-00000999'
    const { shadowed, error } = await commitWithShadowTable(
      'advance_requests',
      // Vacía: para el trigger diferido del agregado la solicitud no existe, así que no cuenta nada.
      (client) =>
        client.query(
          'CREATE TEMP TABLE advance_requests (id uuid, invoice_count integer, earliest_due_date date, total_net_pending numeric) ON COMMIT DROP',
        ),
      async (client) => {
        await insert(client, 'stored_files', {
          ...BASE.stored_files?.(),
          id: fileId,
          status: 'ATTACHED',
          attached_at: NOW,
        })
        await insert(client, 'invoices', {
          ...BASE.invoices?.(),
          advance_request_id: request.id,
          issuer_ruc: request.supplierRuc,
          recipient_ruc: request.payerRuc,
          series_number: seriesNumber,
          invoice_key: invoiceKey({ issuerRuc: request.supplierRuc, seriesNumber }),
          xml_file_id: fileId,
        })
      },
    )
    const [invoices] = await queryRows<{ total: number; net_pending: string }>(
      `SELECT count(*)::int AS total, sum(net_pending_amount)::text AS net_pending
       FROM invoices WHERE advance_request_id = $1`,
      [request.id],
    )
    expect({ shadowed, code: error?.code, constraint: error?.constraint, invoices }).toEqual({
      shadowed: true,
      code: '23000',
      constraint: 'advance_requests_complete',
      invoices: { total: 1, net_pending: '10620.00' },
    })
  })

  it('(i) una tabla temporal llamada advance_request_transitions no abre una transición prohibida (D49)', async () => {
    const request = await createCompleteAdvanceRequest(db.prisma)
    const { shadowed, error } = await commitWithShadowTable(
      'advance_request_transitions',
      async (client) => {
        await client.query(
          'CREATE TEMP TABLE advance_request_transitions (LIKE public.advance_request_transitions) ON COMMIT DROP',
        )
        // NEW -> DISBURSED no está en el catálogo real: desembolsar sin revisión ni aprobación.
        await client.query(
          "INSERT INTO pg_temp.advance_request_transitions VALUES ('NEW', 'DISBURSED', 'AGENT')",
        )
      },
      (client) =>
        client.query(
          "UPDATE advance_requests SET status = 'DISBURSED', version = version + 1, closed_at = now() WHERE id = $1",
          [request.id],
        ),
    )
    const [state] = await queryRows<{ status: string; version: number }>(
      'SELECT status::text AS status, version FROM advance_requests WHERE id = $1',
      [request.id],
    )
    expect({ shadowed, code: error?.code, constraint: error?.constraint, state }).toEqual({
      shadowed: true,
      code: '23000',
      constraint: 'advance_requests_transition_allowed',
      state: { status: 'NEW', version: 1 },
    })
  })

  it('(i) una tabla temporal llamada advance_requests no deja purgar solo las facturas de una solicitud viva (D49)', async () => {
    const request = await createCompleteAdvanceRequest(db.prisma)
    const { shadowed, error } = await commitWithShadowTable(
      'advance_requests',
      // Vacía: para la regla diferida de la purga, la solicitud ya se borró.
      (client) => client.query('CREATE TEMP TABLE advance_requests (id uuid) ON COMMIT DROP'),
      async (client) => {
        await client.query("SET LOCAL app.retention_purge = 'on'")
        await client.query(
          'DELETE FROM invoice_installments WHERE invoice_id IN (SELECT id FROM invoices WHERE advance_request_id = $1)',
          [request.id],
        )
        await client.query('DELETE FROM invoices WHERE advance_request_id = $1', [request.id])
      },
    )
    expect({
      shadowed,
      code: error?.code,
      constraint: error?.constraint,
      leftovers: await aggregateLeftovers(request.id, [onlyInvoiceId(request)], request.fileIds),
    }).toEqual({
      shadowed: true,
      code: '23000',
      constraint: 'invoices_purge_requires_request_purge',
      leftovers: {
        advance_requests: 1,
        invoices: 1,
        invoice_installments: 1,
        consents: 2,
        status_history: 1,
        stored_files: 1,
      },
    })
  })

  it('(i) una solicitud no se puede insertar ya fuera de NEW o con otra versión (D49)', async () => {
    for (const [rule, patch] of [
      ['status', { status: 'APPROVED' }],
      ['version', { version: 7 }],
    ] as const) {
      const error = await sqlError((client) =>
        insert(client, 'advance_requests', { ...BASE.advance_requests?.(), ...patch }),
      )
      expect({ code: error?.code, constraint: error?.constraint }, rule).toEqual({
        code: '23000',
        constraint: 'advance_requests_initial_state',
      })
    }
  })

  it('(j) la base fija los tres timeouts y la app los recibe por su pool', async () => {
    const settings = await queryRows<{ setting: string }>(`
      SELECT unnest(s.setconfig) AS setting FROM pg_db_role_setting s
      JOIN pg_database d ON d.oid = s.setdatabase
      WHERE d.datname = current_database() AND s.setrole = 0`)
    expect(settings.map((row) => row.setting).sort()).toEqual([
      'idle_in_transaction_session_timeout=30s',
      'lock_timeout=5s',
      'statement_timeout=15s',
    ])

    const app = await createTestApp()
    try {
      const prisma = app.get(PrismaService)
      const [timeouts] = await prisma.$queryRawUnsafe<
        {
          statement_timeout: string
          lock_timeout: string
          idle_in_transaction_session_timeout: string
        }[]
      >(
        `SELECT current_setting('statement_timeout') AS statement_timeout,
                current_setting('lock_timeout') AS lock_timeout,
                current_setting('idle_in_transaction_session_timeout') AS idle_in_transaction_session_timeout`,
      )
      expect(timeouts).toEqual({
        statement_timeout: '15s',
        lock_timeout: '5s',
        idle_in_transaction_session_timeout: '30s',
      })
      const [shown] =
        await prisma.$queryRawUnsafe<{ statement_timeout: string }[]>('SHOW statement_timeout')
      expect(shown).toEqual({ statement_timeout: '15s' })
    } finally {
      await app.close()
    }
  })

  it('(k) uuidv7_floor acota los ids reales de su milisegundo y traduce una fecha a un rango de la PK', async () => {
    const appIds = Array.from({ length: 500 }, () => newId())
    const [bounds] = await queryRows<{ total: number; bounded: number }>(
      `WITH ids AS (
         SELECT unnest($1::uuid[]) AS id
         UNION ALL
         SELECT uuidv7() FROM generate_series(1, 500)
       )
       SELECT count(*)::int AS total,
              count(*) FILTER (
                WHERE uuidv7_floor(uuid_extract_timestamp(id)) <= id
                  AND id < uuidv7_floor(uuid_extract_timestamp(id) + interval '1 millisecond')
              )::int AS bounded
       FROM ids`,
      [appIds],
    )
    expect(bounds).toEqual({ total: 1000, bounded: 1000 })

    const client = await pool.connect()
    try {
      const insertLog = async () =>
        (
          await client.query<{ id: string }>(
            "INSERT INTO audit_logs (action, entity) VALUES ('advance-request.viewed', 'advance_request') RETURNING id",
          )
        ).rows[0]?.id
      const before = await insertLog()
      await client.query('SELECT pg_sleep(0.005)')
      const cut = (await client.query<{ cut: Date }>('SELECT clock_timestamp() AS cut')).rows[0]
        ?.cut
      await client.query('SELECT pg_sleep(0.005)')
      const after = await insertLog()
      const { rows } = await client.query<{ id: string }>(
        'SELECT id FROM audit_logs WHERE id >= uuidv7_floor($1) ORDER BY id',
        [cut],
      )
      expect(before).toBeDefined()
      expect(rows.map((row) => row.id)).toEqual([after])
    } finally {
      client.release()
    }
  })
})
