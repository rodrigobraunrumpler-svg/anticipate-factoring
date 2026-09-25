BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Migración inicial. El SQL de abajo lo generó `prisma migrate dev --create-only --name init`; a
-- mano solo se agregan la transacción, la extensión y la secuencia (docs/database/migrations.md).
-- Prisma 7.10 no envuelve las migraciones: sin BEGIN/COMMIT, una que falla a la mitad deja la base
-- a medio aplicar y todo `migrate deploy` posterior se detiene.

-- Trigramas para las búsquedas del admin (índices GIN de suppliers y advance_requests).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Secuencia del código público ANT-{año}-{secuencia}. La API arma el texto con formatPublicCode
-- de shared; la secuencia no se reinicia por año.
CREATE SEQUENCE "advance_request_code_seq" AS bigint;

-- CreateEnum
CREATE TYPE "advance_request_status" AS ENUM ('NEW', 'NO_ANSWER', 'CONTACTED', 'DOCUMENTS_PENDING', 'UNDER_REVIEW', 'QUOTE_SENT', 'APPROVED', 'DISBURSED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "close_reason" AS ENUM ('NO_RESPONSE', 'SPAM_OR_INVALID', 'SUPPLIER_WITHDREW', 'INVALID_DOCUMENTS', 'INVOICE_NOT_ELIGIBLE', 'UNACCEPTABLE_RISK', 'OTHER');

-- CreateEnum
CREATE TYPE "currency" AS ENUM ('PEN', 'USD');

-- CreateEnum
CREATE TYPE "payment_terms" AS ENUM ('CASH', 'CREDIT');

-- CreateEnum
CREATE TYPE "cavali_registration" AS ENUM ('YES', 'NO', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "contact_time_slot" AS ENUM ('MORNING', 'AFTERNOON', 'ANY');

-- CreateEnum
CREATE TYPE "supplier_document_type" AS ENUM ('REPRESENTATIVE_ID', 'POWER_OF_ATTORNEY_CERTIFICATE', 'MASTER_AGREEMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "supplier_document_status" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "follow_up_channel" AS ENUM ('CALL', 'WHATSAPP', 'EMAIL', 'OTHER');

-- CreateEnum
CREATE TYPE "consent_type" AS ENUM ('TERMS', 'PERSONAL_DATA');

-- CreateEnum
CREATE TYPE "role" AS ENUM ('AGENT', 'ADMIN');

-- CreateEnum
CREATE TYPE "outbox_status" AS ENUM ('PENDING', 'PROCESSING', 'PUBLISHED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "stored_file_purpose" AS ENUM ('INVOICE_XML', 'INVOICE_PDF', 'SUPPLIER_DOCUMENT');

-- CreateEnum
CREATE TYPE "stored_file_status" AS ENUM ('PENDING', 'ATTACHED', 'DELETED');

-- CreateTable
CREATE TABLE "payers" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "slug" VARCHAR(60) NOT NULL,
    "ruc" CHAR(11) NOT NULL,
    "legal_name" VARCHAR(200) NOT NULL,
    "short_name" VARCHAR(40) NOT NULL,
    "advance_percent" DECIMAL(5,2) NOT NULL,
    "min_term_days" INTEGER NOT NULL,
    "max_invoices" INTEGER NOT NULL,
    "allowed_currencies" "currency"[],
    "accent_color" VARCHAR(7) NOT NULL,
    "logo_url" TEXT,
    "texts" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "ruc" CHAR(11) NOT NULL,
    "legal_name" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_representatives" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "supplier_id" UUID NOT NULL,
    "full_name" VARCHAR(120) NOT NULL,
    "dni" VARCHAR(8) NOT NULL,
    "job_title" VARCHAR(80),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legal_representatives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_documents" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "supplier_id" UUID NOT NULL,
    "representative_id" UUID,
    "type" "supplier_document_type" NOT NULL,
    "status" "supplier_document_status" NOT NULL DEFAULT 'PENDING_REVIEW',
    "file_id" UUID NOT NULL,
    "file_purpose" "stored_file_purpose" NOT NULL DEFAULT 'SUPPLIER_DOCUMENT',
    "issued_on" DATE,
    "valid_until" DATE,
    "superseded_at" TIMESTAMPTZ(3),
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "advance_requests" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "public_code" VARCHAR(27) NOT NULL,
    "idempotency_key" UUID NOT NULL,
    "request_fingerprint" CHAR(64) NOT NULL,
    "payer_id" UUID NOT NULL,
    "payer_ruc" CHAR(11) NOT NULL,
    "supplier_id" UUID NOT NULL,
    "supplier_ruc" CHAR(11) NOT NULL,
    "supplier_legal_name" VARCHAR(200) NOT NULL,
    "status" "advance_request_status" NOT NULL DEFAULT 'NEW',
    "contact_full_name" VARCHAR(120) NOT NULL,
    "contact_dni" VARCHAR(8) NOT NULL,
    "contact_mobile" VARCHAR(9) NOT NULL,
    "contact_email" VARCHAR(254) NOT NULL,
    "is_legal_representative" BOOLEAN NOT NULL,
    "legal_representative_id" UUID,
    "contact_job_title" VARCHAR(80),
    "contact_time_slot" "contact_time_slot" NOT NULL,
    "requested_amount" DECIMAL(14,2) NOT NULL,
    "currency" "currency" NOT NULL,
    "applied_advance_percent" DECIMAL(5,2) NOT NULL,
    "applied_min_term_days" INTEGER NOT NULL,
    "total_net_pending" DECIMAL(14,2) NOT NULL,
    "max_amount" DECIMAL(14,2) NOT NULL,
    "purpose" VARCHAR(500),
    "cavali_registration" "cavali_registration" NOT NULL,
    "utm" JSONB,
    "referrer" VARCHAR(2000),
    "correlation_id" VARCHAR(128),
    "close_reason" "close_reason",
    "close_reason_detail" VARCHAR(500),
    "closed_at" TIMESTAMPTZ(3),
    "invoice_count" SMALLINT NOT NULL,
    "earliest_due_date" DATE NOT NULL,
    "next_action_at" TIMESTAMPTZ(3),
    "assigned_to_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "advance_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "advance_request_id" UUID NOT NULL,
    "request_status" "advance_request_status" NOT NULL,
    "currency" "currency" NOT NULL,
    "issuer_ruc" CHAR(11) NOT NULL,
    "recipient_ruc" CHAR(11) NOT NULL,
    "document_type" VARCHAR(2) NOT NULL,
    "series_number" VARCHAR(20) NOT NULL,
    "invoice_key" VARCHAR(40) NOT NULL,
    "issuer_name" VARCHAR(1500) NOT NULL,
    "payment_terms" "payment_terms" NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "net_pending_amount" DECIMAL(14,2) NOT NULL,
    "issue_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "detraction" JSONB,
    "signed" BOOLEAN NOT NULL,
    "xml_file_id" UUID NOT NULL,
    "xml_file_purpose" "stored_file_purpose" NOT NULL DEFAULT 'INVOICE_XML',
    "pdf_file_id" UUID,
    "pdf_file_purpose" "stored_file_purpose" NOT NULL DEFAULT 'INVOICE_PDF',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_installments" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "invoice_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "label" VARCHAR(20) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "due_date" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_installments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stored_files" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "storage_bucket" VARCHAR(63) NOT NULL,
    "key" VARCHAR(512) NOT NULL,
    "purpose" "stored_file_purpose" NOT NULL,
    "content_type" VARCHAR(100) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "status" "stored_file_status" NOT NULL DEFAULT 'PENDING',
    "attached_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "purge_after" TIMESTAMPTZ(3),
    "purged_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stored_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "follow_ups" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "advance_request_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "channel" "follow_up_channel" NOT NULL,
    "note" VARCHAR(2000) NOT NULL,
    "next_action_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "follow_ups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "advance_request_transitions" (
    "from_status" "advance_request_status" NOT NULL,
    "to_status" "advance_request_status" NOT NULL,
    "min_role" "role" NOT NULL,

    CONSTRAINT "advance_request_transitions_pkey" PRIMARY KEY ("from_status","to_status")
);

-- CreateTable
CREATE TABLE "close_reason_rules" (
    "status" "advance_request_status" NOT NULL,
    "reason" "close_reason" NOT NULL,

    CONSTRAINT "close_reason_rules_pkey" PRIMARY KEY ("status","reason")
);

-- CreateTable
CREATE TABLE "status_history" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "advance_request_id" UUID NOT NULL,
    "from_status" "advance_request_status",
    "to_status" "advance_request_status" NOT NULL,
    "version" INTEGER NOT NULL,
    "user_id" UUID,
    "actor_role" "role",
    "close_reason" "close_reason",
    "close_reason_detail" VARCHAR(500),
    "correlation_id" VARCHAR(128),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_document_versions" (
    "type" "consent_type" NOT NULL,
    "version" VARCHAR(20) NOT NULL,
    "url" VARCHAR(500) NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "published_at" TIMESTAMPTZ(3) NOT NULL,
    "retired_at" TIMESTAMPTZ(3),

    CONSTRAINT "legal_document_versions_pkey" PRIMARY KEY ("type","version")
);

-- CreateTable
CREATE TABLE "consents" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "advance_request_id" UUID NOT NULL,
    "type" "consent_type" NOT NULL,
    "document_version" VARCHAR(20) NOT NULL,
    "ip" INET NOT NULL,
    "user_agent" VARCHAR(512),
    "accepted_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "email" VARCHAR(254) NOT NULL,
    "full_name" VARCHAR(120) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "role" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" UUID,
    "actor_role" "role",
    "action" VARCHAR(60) NOT NULL,
    "entity" VARCHAR(60) NOT NULL,
    "entity_id" UUID,
    "detail" JSONB,
    "ip" INET,
    "correlation_id" VARCHAR(128),

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "handler" VARCHAR(60) NOT NULL,
    "dedupe_key" VARCHAR(200) NOT NULL,
    "event_type" VARCHAR(60) NOT NULL,
    "payload" JSONB NOT NULL,
    "advance_request_id" UUID,
    "status" "outbox_status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_token" UUID,
    "locked_at" TIMESTAMPTZ(3),
    "lock_expires_at" TIMESTAMPTZ(3),
    "published_at" TIMESTAMPTZ(3),
    "last_error" VARCHAR(64),
    "provider_message_id" VARCHAR(255),
    "correlation_id" VARCHAR(128),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payers_slug_key" ON "payers"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "payers_ruc_key" ON "payers"("ruc");

-- CreateIndex
CREATE UNIQUE INDEX "payers_id_ruc_key" ON "payers"("id", "ruc");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_ruc_key" ON "suppliers"("ruc");

-- CreateIndex
CREATE INDEX "suppliers_legal_name_trgm_idx" ON "suppliers" USING GIN ("legal_name" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_id_ruc_key" ON "suppliers"("id", "ruc");

-- CreateIndex
CREATE UNIQUE INDEX "legal_representatives_supplier_id_dni_key" ON "legal_representatives"("supplier_id", "dni");

-- CreateIndex
CREATE UNIQUE INDEX "legal_representatives_id_supplier_key" ON "legal_representatives"("id", "supplier_id");

-- CreateIndex
CREATE INDEX "supplier_documents_supplier_type_status_idx" ON "supplier_documents"("supplier_id", "type", "status");

-- CreateIndex
CREATE INDEX "supplier_documents_representative_idx" ON "supplier_documents"("representative_id", "supplier_id");

-- CreateIndex
CREATE INDEX "supplier_documents_valid_until_current_idx" ON "supplier_documents"("valid_until") WHERE ("superseded_at" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "supplier_documents_file_key" ON "supplier_documents"("file_id", "file_purpose");

-- CreateIndex
CREATE UNIQUE INDEX "advance_requests_public_code_key" ON "advance_requests"("public_code");

-- CreateIndex
CREATE UNIQUE INDEX "advance_requests_idempotency_key_key" ON "advance_requests"("idempotency_key");

-- CreateIndex
CREATE INDEX "advance_requests_open_idx" ON "advance_requests"("id" DESC) WHERE ("closed_at" IS NULL);

-- CreateIndex
CREATE INDEX "advance_requests_status_id_idx" ON "advance_requests"("status", "id" DESC);

-- CreateIndex
CREATE INDEX "advance_requests_payer_id_id_idx" ON "advance_requests"("payer_id", "id" DESC);

-- CreateIndex
CREATE INDEX "advance_requests_supplier_id_id_idx" ON "advance_requests"("supplier_id", "id" DESC);

-- CreateIndex
CREATE INDEX "advance_requests_assigned_to_id_id_idx" ON "advance_requests"("assigned_to_id", "id" DESC);

-- CreateIndex
CREATE INDEX "advance_requests_open_assigned_idx" ON "advance_requests"("assigned_to_id", "id" DESC) WHERE ("closed_at" IS NULL);

-- CreateIndex
CREATE INDEX "advance_requests_next_action_idx" ON "advance_requests"("next_action_at") WHERE ("closed_at" IS NULL AND "next_action_at" IS NOT NULL);

-- CreateIndex
CREATE INDEX "advance_requests_assigned_next_action_idx" ON "advance_requests"("assigned_to_id", "next_action_at") WHERE ("closed_at" IS NULL AND "next_action_at" IS NOT NULL);

-- CreateIndex
CREATE INDEX "advance_requests_legal_representative_idx" ON "advance_requests"("legal_representative_id", "supplier_id");

-- CreateIndex
CREATE INDEX "advance_requests_contact_dni_idx" ON "advance_requests"("contact_dni");

-- CreateIndex
CREATE INDEX "advance_requests_contact_mobile_idx" ON "advance_requests"("contact_mobile");

-- CreateIndex
CREATE INDEX "advance_requests_contact_email_idx" ON "advance_requests"("contact_email");

-- CreateIndex
CREATE INDEX "advance_requests_contact_full_name_trgm_idx" ON "advance_requests" USING GIN ("contact_full_name" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "advance_requests_invoice_scope_key" ON "advance_requests"("id", "status", "currency", "supplier_ruc", "payer_ruc");

-- CreateIndex
CREATE INDEX "invoices_advance_request_id_idx" ON "invoices"("advance_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_xml_file_key" ON "invoices"("xml_file_id", "xml_file_purpose");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_pdf_file_key" ON "invoices"("pdf_file_id", "pdf_file_purpose");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_open_invoice_key_key" ON "invoices"("invoice_key") WHERE (request_status <> ALL (ARRAY['REJECTED'::advance_request_status, 'WITHDRAWN'::advance_request_status]));

-- CreateIndex
CREATE INDEX "invoice_installments_due_date_idx" ON "invoice_installments"("due_date");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_installments_invoice_id_number_key" ON "invoice_installments"("invoice_id", "number");

-- CreateIndex
CREATE INDEX "stored_files_pending_created_at_idx" ON "stored_files"("created_at") WHERE (status = 'PENDING'::stored_file_status);

-- CreateIndex
CREATE INDEX "stored_files_purge_after_idx" ON "stored_files"("purge_after") WHERE ("purged_at" IS NULL AND "deleted_at" IS NOT NULL);

-- CreateIndex
CREATE UNIQUE INDEX "stored_files_storage_bucket_key_key" ON "stored_files"("storage_bucket", "key");

-- CreateIndex
CREATE UNIQUE INDEX "stored_files_id_purpose_key" ON "stored_files"("id", "purpose");

-- CreateIndex
CREATE INDEX "follow_ups_advance_request_id_created_at_idx" ON "follow_ups"("advance_request_id", "created_at");

-- CreateIndex
CREATE INDEX "follow_ups_user_id_created_at_idx" ON "follow_ups"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "status_history_user_id_idx" ON "status_history"("user_id");

-- CreateIndex
CREATE INDEX "status_history_transition_idx" ON "status_history"("from_status", "to_status");

-- CreateIndex
CREATE INDEX "status_history_close_rule_idx" ON "status_history"("to_status", "close_reason");

-- CreateIndex
CREATE UNIQUE INDEX "status_history_advance_request_id_version_key" ON "status_history"("advance_request_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "status_history_one_initial_key" ON "status_history"("advance_request_id") WHERE (from_status IS NULL);

-- CreateIndex
CREATE INDEX "consents_legal_document_idx" ON "consents"("type", "document_version");

-- CreateIndex
CREATE UNIQUE INDEX "consents_advance_request_id_type_key" ON "consents"("advance_request_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "audit_logs_entity_id_created_at_idx" ON "audit_logs"("entity_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_user_id_created_at_idx" ON "audit_logs"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_created_brin_idx" ON "audit_logs" USING BRIN ("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_dedupe_key_key" ON "outbox_events"("dedupe_key");

-- CreateIndex
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events"("handler", "available_at") WHERE (status = 'PENDING'::outbox_status);

-- CreateIndex
CREATE INDEX "outbox_events_processing_idx" ON "outbox_events"("lock_expires_at") WHERE (status = 'PROCESSING'::outbox_status);

-- CreateIndex
CREATE INDEX "outbox_events_advance_request_id_idx" ON "outbox_events"("advance_request_id");

-- CreateIndex
CREATE INDEX "outbox_events_dead_letter_idx" ON "outbox_events"("created_at" DESC) WHERE (status = 'DEAD_LETTER'::outbox_status);

-- AddForeignKey
ALTER TABLE "legal_representatives" ADD CONSTRAINT "legal_representatives_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "supplier_documents" ADD CONSTRAINT "supplier_documents_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "supplier_documents" ADD CONSTRAINT "supplier_documents_representative_fkey" FOREIGN KEY ("representative_id", "supplier_id") REFERENCES "legal_representatives"("id", "supplier_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "supplier_documents" ADD CONSTRAINT "supplier_documents_file_fkey" FOREIGN KEY ("file_id", "file_purpose") REFERENCES "stored_files"("id", "purpose") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "supplier_documents" ADD CONSTRAINT "supplier_documents_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "advance_requests" ADD CONSTRAINT "advance_requests_payer_fkey" FOREIGN KEY ("payer_id", "payer_ruc") REFERENCES "payers"("id", "ruc") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "advance_requests" ADD CONSTRAINT "advance_requests_supplier_fkey" FOREIGN KEY ("supplier_id", "supplier_ruc") REFERENCES "suppliers"("id", "ruc") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "advance_requests" ADD CONSTRAINT "advance_requests_legal_representative_fkey" FOREIGN KEY ("legal_representative_id", "supplier_id") REFERENCES "legal_representatives"("id", "supplier_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "advance_requests" ADD CONSTRAINT "advance_requests_close_rule_fkey" FOREIGN KEY ("status", "close_reason") REFERENCES "close_reason_rules"("status", "reason") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "advance_requests" ADD CONSTRAINT "advance_requests_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_request_scope_fkey" FOREIGN KEY ("advance_request_id", "request_status", "currency", "issuer_ruc", "recipient_ruc") REFERENCES "advance_requests"("id", "status", "currency", "supplier_ruc", "payer_ruc") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_xml_file_fkey" FOREIGN KEY ("xml_file_id", "xml_file_purpose") REFERENCES "stored_files"("id", "purpose") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_pdf_file_fkey" FOREIGN KEY ("pdf_file_id", "pdf_file_purpose") REFERENCES "stored_files"("id", "purpose") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "invoice_installments" ADD CONSTRAINT "invoice_installments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_advance_request_id_fkey" FOREIGN KEY ("advance_request_id") REFERENCES "advance_requests"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "status_history" ADD CONSTRAINT "status_history_advance_request_id_fkey" FOREIGN KEY ("advance_request_id") REFERENCES "advance_requests"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "status_history" ADD CONSTRAINT "status_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "status_history" ADD CONSTRAINT "status_history_transition_fkey" FOREIGN KEY ("from_status", "to_status") REFERENCES "advance_request_transitions"("from_status", "to_status") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "status_history" ADD CONSTRAINT "status_history_close_rule_fkey" FOREIGN KEY ("to_status", "close_reason") REFERENCES "close_reason_rules"("status", "reason") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "consents" ADD CONSTRAINT "consents_advance_request_id_fkey" FOREIGN KEY ("advance_request_id") REFERENCES "advance_requests"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "consents" ADD CONSTRAINT "consents_legal_document_fkey" FOREIGN KEY ("type", "document_version") REFERENCES "legal_document_versions"("type", "version") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_advance_request_id_fkey" FOREIGN KEY ("advance_request_id") REFERENCES "advance_requests"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

COMMIT;
