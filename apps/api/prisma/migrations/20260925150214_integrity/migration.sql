-- Invariantes de la base (Tarea 7). Escrita a mano: Prisma no representa CHECK, funciones ni
-- triggers y `prisma migrate diff` no los ve; los cubre test/integration/database-structure.test.ts.
-- Cada CHECK sobre datos que vienen de afuera es espejo de una regla de @anticipate/shared.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 1. Parámetros de la base: iguales en local, CI y Neon, con o sin pooler. Van aquí y no en
--    pg.Pool porque PgBouncer en modo transacción rechaza parámetros de arranque. Rigen para las
--    sesiones nuevas; toda migración fija los suyos con SET LOCAL al empezar.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET statement_timeout = %L', current_database(), '15s');
  EXECUTE format('ALTER DATABASE %I SET lock_timeout = %L', current_database(), '5s');
  EXECUTE format('ALTER DATABASE %I SET idle_in_transaction_session_timeout = %L', current_database(), '30s');
END
$$;

-- 2. Funciones inmutables. Cuerpos SQL estándar (RETURN): PostgreSQL resuelve los nombres al
--    crearlas, así una restauración con search_path vacío no las rompe.

-- String.prototype.trim de JavaScript (lo que hace `.trim()` de Zod): quita WhiteSpace y
-- LineTerminator de ECMAScript en los dos extremos. btrim solo quita espacios.
CREATE FUNCTION js_trim(value text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  RETURN regexp_replace(
    value,
    '^[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+|[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+$',
    '',
    'g'
  );

-- String.prototype.length de JavaScript (lo que miden `.min()` y `.max()` de Zod): unidades
-- UTF-16, así un carácter fuera del plano básico cuenta dos.
CREATE FUNCTION js_length(value text) RETURNS integer
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  RETURN char_length(value) + char_length(regexp_replace(value, '[^\U00010000-\U0010FFFF]', '', 'g'));

-- isValidRuc de shared: prefijo de SUNAT y dígito verificador módulo 11. El resto 10 da 0 y el
-- 11 da 1, que es lo mismo que (11 - suma % 11) % 10. ascii() nunca falla, sea cual sea la entrada.
CREATE FUNCTION is_valid_ruc(value text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  RETURN CASE
    WHEN value !~ '^(10|15|16|17|20)[0-9]{9}$' THEN false
    ELSE (11 - (
        5 * (ascii(substr(value, 1, 1)) - 48) + 4 * (ascii(substr(value, 2, 1)) - 48)
      + 3 * (ascii(substr(value, 3, 1)) - 48) + 2 * (ascii(substr(value, 4, 1)) - 48)
      + 7 * (ascii(substr(value, 5, 1)) - 48) + 6 * (ascii(substr(value, 6, 1)) - 48)
      + 5 * (ascii(substr(value, 7, 1)) - 48) + 4 * (ascii(substr(value, 8, 1)) - 48)
      + 3 * (ascii(substr(value, 9, 1)) - 48) + 2 * (ascii(substr(value, 10, 1)) - 48)
    ) % 11) % 10 = ascii(substr(value, 11, 1)) - 48
  END;

-- Contrato de `texts` en publicPayerSchema: objeto de hasta 30 claves camelCase de hasta 40
-- caracteres, cada valor un texto de hasta 2000 caracteres después de `.trim()`.
CREATE FUNCTION is_valid_payer_texts(texts jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  RETURN CASE
    WHEN jsonb_typeof(texts) <> 'object' THEN false
    ELSE (
      SELECT count(*) <= 30
        AND coalesce(bool_and(
          key ~ '^[a-z][a-zA-Z0-9]{0,39}$'
          AND jsonb_typeof(value) = 'string'
          AND js_length(js_trim(value #>> '{}')) <= 2000
        ), true)
      FROM jsonb_each(texts)
    )
  END;

-- invoiceKey de shared para una serie ya canónica (la CHECK de series_number fija el formato):
-- RUC del emisor, barra, serie y correlativo sin ceros a la izquierda.
CREATE FUNCTION canonical_invoice_key(issuer_ruc text, series_number text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  RETURN issuer_ruc || '|' || split_part(series_number, '-', 1) || '-'
    || regexp_replace(split_part(series_number, '-', 2), '^0+(?=[0-9])', '');

-- El menor UUIDv7 del milisegundo de `moment`: 48 bits de tiempo, versión 7, variante 10 y el
-- resto en cero. Traduce un rango de fechas a un rango de la PK (purgas y listas del admin).
CREATE FUNCTION uuidv7_floor(moment timestamptz) RETURNS uuid
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  RETURN (lpad(to_hex(floor(extract(epoch FROM moment) * 1000)::bigint), 12, '0') || '70008000000000000000')::uuid;

-- 3. CHECK (<tabla>_<regla>_check), espejo de shared. Las tablas están vacías en todo entorno
--    cuando corre esta migración: por eso no usan NOT VALID (regla 5 de docs/database/migrations.md).

-- publicPayerSchema, slugSchema e isHexColor.
ALTER TABLE payers
  ADD CONSTRAINT payers_slug_check CHECK (char_length(slug) <= 60 AND slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  ADD CONSTRAINT payers_ruc_check CHECK (is_valid_ruc(ruc)),
  ADD CONSTRAINT payers_legal_name_check CHECK (js_length(js_trim(legal_name)) BETWEEN 3 AND 200),
  ADD CONSTRAINT payers_short_name_check CHECK (js_length(js_trim(short_name)) BETWEEN 2 AND 40),
  ADD CONSTRAINT payers_advance_percent_check CHECK (advance_percent BETWEEN 1 AND 100),
  ADD CONSTRAINT payers_min_term_days_check CHECK (min_term_days >= 0),
  ADD CONSTRAINT payers_max_invoices_check CHECK (max_invoices BETWEEN 1 AND 100),
  ADD CONSTRAINT payers_allowed_currencies_check CHECK (
    allowed_currencies IS NOT NULL
    AND cardinality(allowed_currencies) >= 1
    AND array_position(allowed_currencies, NULL) IS NULL
  ),
  ADD CONSTRAINT payers_accent_color_check CHECK (accent_color ~ '^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$'),
  -- z.httpUrl(): esquema http o https (sin distinguir mayúsculas, como Zod) y nombre de dominio
  -- con el patrón de Zod. Es un subconjunto de lo que acepta Zod: sin puerto, credenciales ni
  -- espacios; toda fila que pasa aquí pasa publicPayerSchema.
  ADD CONSTRAINT payers_logo_url_check CHECK (
    logo_url IS NULL
    OR logo_url ~* '^https?://(?=[^/?#]{1,253}(?:[/?#]|$))(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?:[/?#][^[:space:][:cntrl:]]*)?$'
  ),
  ADD CONSTRAINT payers_texts_check CHECK (is_valid_payer_texts(texts));

-- rucSchema y company.legalName del formulario.
ALTER TABLE suppliers
  ADD CONSTRAINT suppliers_ruc_check CHECK (is_valid_ruc(ruc)),
  ADD CONSTRAINT suppliers_legal_name_check CHECK (btrim(legal_name) <> '');

-- dniSchema.
ALTER TABLE legal_representatives
  ADD CONSTRAINT legal_representatives_dni_check CHECK (dni ~ '^[0-9]{8}$'),
  ADD CONSTRAINT legal_representatives_full_name_check CHECK (btrim(full_name) <> '');

-- supplier-document de shared: requiresValidity y computeValidUntil (DNI y vigencia de poder
-- vencen; contrato marco y otros no), y los documentos de un representante lo nombran.
ALTER TABLE supplier_documents
  ADD CONSTRAINT supplier_documents_file_purpose_check CHECK (file_purpose = 'SUPPLIER_DOCUMENT'),
  ADD CONSTRAINT supplier_documents_representative_check CHECK (
    type NOT IN ('REPRESENTATIVE_ID', 'POWER_OF_ATTORNEY_CERTIFICATE') OR representative_id IS NOT NULL
  ),
  ADD CONSTRAINT supplier_documents_valid_until_required_check CHECK (
    status <> 'APPROVED' OR type NOT IN ('REPRESENTATIVE_ID', 'POWER_OF_ATTORNEY_CERTIFICATE') OR valid_until IS NOT NULL
  ),
  ADD CONSTRAINT supplier_documents_valid_until_not_applicable_check CHECK (
    type IN ('REPRESENTATIVE_ID', 'POWER_OF_ATTORNEY_CERTIFICATE') OR valid_until IS NULL
  ),
  ADD CONSTRAINT supplier_documents_issued_on_check CHECK (
    status <> 'APPROVED' OR type <> 'POWER_OF_ATTORNEY_CERTIFICATE' OR issued_on IS NOT NULL
  ),
  ADD CONSTRAINT supplier_documents_review_check CHECK (
    (status = 'PENDING_REVIEW') = (reviewed_by_id IS NULL AND reviewed_at IS NULL)
  ),
  ADD CONSTRAINT supplier_documents_validity_range_check CHECK (
    valid_until IS NULL OR issued_on IS NULL OR valid_until >= issued_on
  );

-- advanceRequestFormSchema, publicCodeSchema, percentOf y la máquina de estados.
ALTER TABLE advance_requests
  ADD CONSTRAINT advance_requests_id_version_check CHECK (uuid_extract_version(id) = 7),
  ADD CONSTRAINT advance_requests_public_code_check CHECK (public_code ~ '^[A-Z]{2,6}-[0-9]{4}-[0-9]{6,15}$'),
  ADD CONSTRAINT advance_requests_request_fingerprint_check CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT advance_requests_contact_full_name_check CHECK (char_length(btrim(contact_full_name)) >= 3),
  ADD CONSTRAINT advance_requests_contact_dni_check CHECK (contact_dni ~ '^[0-9]{8}$'),
  ADD CONSTRAINT advance_requests_contact_mobile_check CHECK (contact_mobile ~ '^9[0-9]{8}$'),
  ADD CONSTRAINT advance_requests_contact_email_check CHECK (contact_email = lower(contact_email)),
  ADD CONSTRAINT advance_requests_contact_job_title_check CHECK (is_legal_representative OR contact_job_title IS NOT NULL),
  ADD CONSTRAINT advance_requests_legal_representative_check CHECK ((legal_representative_id IS NOT NULL) = is_legal_representative),
  ADD CONSTRAINT advance_requests_requested_amount_check CHECK (requested_amount > 0 AND requested_amount <= max_amount),
  ADD CONSTRAINT advance_requests_snapshot_check CHECK (
    total_net_pending > 0 AND applied_advance_percent BETWEEN 1 AND 100 AND applied_min_term_days >= 0
  ),
  -- percentOf de shared: redondeo hacia abajo a dos decimales.
  ADD CONSTRAINT advance_requests_max_amount_check CHECK (max_amount = trunc(total_net_pending * applied_advance_percent / 100, 2)),
  ADD CONSTRAINT advance_requests_version_check CHECK (version >= 1),
  ADD CONSTRAINT advance_requests_close_reason_check CHECK (
    (status = ANY (ARRAY['REJECTED', 'WITHDRAWN']::advance_request_status[])) = (close_reason IS NOT NULL)
  ),
  ADD CONSTRAINT advance_requests_close_reason_detail_check CHECK (
    close_reason IS DISTINCT FROM 'OTHER' OR coalesce(btrim(close_reason_detail), '') <> ''
  ),
  ADD CONSTRAINT advance_requests_closed_at_check CHECK (
    (status = ANY (ARRAY['DISBURSED', 'REJECTED', 'WITHDRAWN']::advance_request_status[])) = (closed_at IS NOT NULL)
  ),
  ADD CONSTRAINT advance_requests_next_action_check CHECK (next_action_at IS NULL OR closed_at IS NULL),
  ADD CONSTRAINT advance_requests_utm_check CHECK (utm IS NULL OR jsonb_typeof(utm) = 'object'),
  -- z.httpUrl() acepta el esquema sin distinguir mayúsculas (HTTPS://EJEMPLO.PE) y lo guarda tal cual.
  ADD CONSTRAINT advance_requests_referrer_check CHECK (referrer IS NULL OR referrer ~* '^https?://'),
  ADD CONSTRAINT advance_requests_purpose_check CHECK (purpose IS NULL OR btrim(purpose) <> ''),
  ADD CONSTRAINT advance_requests_invoice_count_check CHECK (invoice_count BETWEEN 1 AND 100);

-- Reglas de factura de shared: document-type, credit-with-pending-amount, net-pending-within-total,
-- issue-date-before-due, el formato de parsedInvoiceSchema e invoiceKey.
ALTER TABLE invoices
  ADD CONSTRAINT invoices_id_version_check CHECK (uuid_extract_version(id) = 7),
  ADD CONSTRAINT invoices_document_type_check CHECK (document_type = '01'),
  ADD CONSTRAINT invoices_payment_terms_check CHECK (payment_terms = 'CREDIT'),
  ADD CONSTRAINT invoices_series_number_check CHECK (series_number ~ '^[A-Z0-9]{4}-[0-9]{1,8}$'),
  ADD CONSTRAINT invoices_invoice_key_check CHECK (invoice_key = canonical_invoice_key(issuer_ruc, series_number)),
  ADD CONSTRAINT invoices_net_pending_amount_check CHECK (net_pending_amount > 0 AND net_pending_amount <= total),
  ADD CONSTRAINT invoices_dates_check CHECK (due_date >= issue_date),
  ADD CONSTRAINT invoices_xml_file_purpose_check CHECK (xml_file_purpose = 'INVOICE_XML'),
  ADD CONSTRAINT invoices_pdf_file_purpose_check CHECK (pdf_file_purpose = 'INVOICE_PDF'),
  ADD CONSTRAINT invoices_detraction_check CHECK (detraction IS NULL OR jsonb_typeof(detraction) = 'object');

-- installment-amounts-positive e installmentSchema.
ALTER TABLE invoice_installments
  ADD CONSTRAINT invoice_installments_number_check CHECK (number >= 1),
  ADD CONSTRAINT invoice_installments_amount_check CHECK (amount > 0),
  ADD CONSTRAINT invoice_installments_label_check CHECK (btrim(label) <> '');

-- Ciclo de vida de archivos: PENDING al reservar, ATTACHED al confirmar, DELETED al liberar.
ALTER TABLE stored_files
  ADD CONSTRAINT stored_files_id_version_check CHECK (uuid_extract_version(id) = 7),
  ADD CONSTRAINT stored_files_size_bytes_check CHECK (size_bytes > 0),
  ADD CONSTRAINT stored_files_sha256_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT stored_files_content_type_check CHECK (
    content_type = ANY (ARRAY['application/xml', 'application/pdf', 'image/jpeg', 'image/png'])
  ),
  ADD CONSTRAINT stored_files_xml_content_type_check CHECK ((purpose = 'INVOICE_XML') = (content_type = 'application/xml')),
  ADD CONSTRAINT stored_files_pdf_content_type_check CHECK (purpose <> 'INVOICE_PDF' OR content_type = 'application/pdf'),
  ADD CONSTRAINT stored_files_status_check CHECK (
    CASE status
      WHEN 'PENDING' THEN attached_at IS NULL AND deleted_at IS NULL AND purged_at IS NULL
      WHEN 'ATTACHED' THEN attached_at IS NOT NULL AND deleted_at IS NULL AND purged_at IS NULL
      WHEN 'DELETED' THEN deleted_at IS NOT NULL AND purge_after IS NOT NULL
    END
  );

ALTER TABLE status_history
  ADD CONSTRAINT status_history_initial_check CHECK ((from_status IS NULL) = (version = 1)),
  ADD CONSTRAINT status_history_initial_status_check CHECK (from_status IS NOT NULL OR to_status = 'NEW'),
  ADD CONSTRAINT status_history_actor_check CHECK ((user_id IS NULL) = (actor_role IS NULL)),
  ADD CONSTRAINT status_history_close_reason_check CHECK (
    (to_status = ANY (ARRAY['REJECTED', 'WITHDRAWN']::advance_request_status[])) = (close_reason IS NOT NULL)
  ),
  ADD CONSTRAINT status_history_close_reason_detail_check CHECK (
    close_reason IS DISTINCT FROM 'OTHER' OR coalesce(btrim(close_reason_detail), '') <> ''
  );

ALTER TABLE consents
  ADD CONSTRAINT consents_document_version_check CHECK (btrim(document_version) <> '');

ALTER TABLE users
  ADD CONSTRAINT users_email_check CHECK (email = lower(email)),
  ADD CONSTRAINT users_full_name_check CHECK (btrim(full_name) <> ''),
  ADD CONSTRAINT users_password_hash_check CHECK (password_hash LIKE '$argon2id$%');

ALTER TABLE follow_ups
  ADD CONSTRAINT follow_ups_note_check CHECK (btrim(note) <> '');

ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_actor_check CHECK ((user_id IS NULL) = (actor_role IS NULL));

ALTER TABLE outbox_events
  ADD CONSTRAINT outbox_events_id_version_check CHECK (uuid_extract_version(id) = 7),
  ADD CONSTRAINT outbox_events_handler_check CHECK (handler ~ '^[a-z0-9]+([.-][a-z0-9]+)*$'),
  ADD CONSTRAINT outbox_events_event_type_check CHECK (btrim(event_type) <> ''),
  ADD CONSTRAINT outbox_events_payload_check CHECK (
    jsonb_typeof(payload) = 'object' AND payload ->> 'type' IS NOT DISTINCT FROM event_type
  ),
  ADD CONSTRAINT outbox_events_aggregate_check CHECK (num_nonnulls(advance_request_id) = 1),
  ADD CONSTRAINT outbox_events_attempts_check CHECK (max_attempts >= 1 AND attempts BETWEEN 0 AND max_attempts),
  ADD CONSTRAINT outbox_events_lease_check CHECK (
    (status = 'PROCESSING') = (lease_token IS NOT NULL AND locked_at IS NOT NULL AND lock_expires_at IS NOT NULL)
  ),
  ADD CONSTRAINT outbox_events_published_check CHECK ((status = 'PUBLISHED') = (published_at IS NOT NULL));

-- 4. Máquina de estados como datos: TRANSITIONS (min_role = minRole ?? 'AGENT') y
--    CLOSE_REASONS_BY_STATUS de @anticipate/shared/advance-request. Un cambio en shared exige una
--    migración nueva; database-structure.test.ts compara estas filas con shared.
INSERT INTO advance_request_transitions (from_status, to_status, min_role) VALUES
  ('NEW', 'CONTACTED', 'AGENT'),
  ('NEW', 'NO_ANSWER', 'AGENT'),
  ('NEW', 'WITHDRAWN', 'AGENT'),
  ('NO_ANSWER', 'CONTACTED', 'AGENT'),
  ('NO_ANSWER', 'WITHDRAWN', 'AGENT'),
  ('CONTACTED', 'DOCUMENTS_PENDING', 'AGENT'),
  ('CONTACTED', 'WITHDRAWN', 'AGENT'),
  ('DOCUMENTS_PENDING', 'UNDER_REVIEW', 'AGENT'),
  ('DOCUMENTS_PENDING', 'REJECTED', 'AGENT'),
  ('DOCUMENTS_PENDING', 'WITHDRAWN', 'AGENT'),
  ('UNDER_REVIEW', 'QUOTE_SENT', 'AGENT'),
  ('UNDER_REVIEW', 'REJECTED', 'AGENT'),
  ('UNDER_REVIEW', 'WITHDRAWN', 'AGENT'),
  ('QUOTE_SENT', 'APPROVED', 'AGENT'),
  ('QUOTE_SENT', 'WITHDRAWN', 'AGENT'),
  ('APPROVED', 'DISBURSED', 'ADMIN'),
  ('APPROVED', 'WITHDRAWN', 'AGENT');

INSERT INTO close_reason_rules (status, reason) VALUES
  ('REJECTED', 'INVALID_DOCUMENTS'),
  ('REJECTED', 'INVOICE_NOT_ELIGIBLE'),
  ('REJECTED', 'UNACCEPTABLE_RISK'),
  ('REJECTED', 'SPAM_OR_INVALID'),
  ('REJECTED', 'OTHER'),
  ('WITHDRAWN', 'NO_RESPONSE'),
  ('WITHDRAWN', 'SUPPLIER_WITHDREW'),
  ('WITHDRAWN', 'SPAM_OR_INVALID'),
  ('WITHDRAWN', 'OTHER');

-- 5. Triggers. Cada error lleva en CONSTRAINT el nombre de la regla que rompe: el driver lo
--    entrega en `constraint` y los tests lo comparan. TRUNCATE no dispara triggers de fila.

-- updated_at lo pone la base, también para el SQL crudo. Se crea en toda tabla con updated_at
-- como <tabla>_set_updated_at; el test estructural exige lo mismo para las tablas futuras.
CREATE FUNCTION set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

DO $$
DECLARE
  target text;
BEGIN
  FOR target IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND c.column_name = 'updated_at' AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_name
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      target || '_set_updated_at',
      target
    );
  END LOOP;
END
$$;

-- Identidad inmutable, versión + 1 en cada cambio (bloqueo optimista, D28) y solo transiciones
-- de advance_request_transitions.
CREATE FUNCTION advance_requests_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.public_code, NEW.idempotency_key, NEW.request_fingerprint, NEW.payer_id, NEW.payer_ruc,
      NEW.supplier_id, NEW.supplier_ruc, NEW.currency, NEW.requested_amount, NEW.applied_advance_percent,
      NEW.applied_min_term_days, NEW.total_net_pending, NEW.max_amount, NEW.invoice_count,
      NEW.earliest_due_date, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.public_code, OLD.idempotency_key, OLD.request_fingerprint, OLD.payer_id, OLD.payer_ruc,
      OLD.supplier_id, OLD.supplier_ruc, OLD.currency, OLD.requested_amount, OLD.applied_advance_percent,
      OLD.applied_min_term_days, OLD.total_net_pending, OLD.max_amount, OLD.invoice_count,
      OLD.earliest_due_date, OLD.created_at) THEN
    RAISE EXCEPTION 'La identidad de la solicitud % no se puede modificar.', OLD.id
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'advance_requests_identity_immutable';
  END IF;
  IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
    RAISE EXCEPTION 'La solicitud % debe pasar de la versión % a la %.', OLD.id, OLD.version, OLD.version + 1
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'advance_requests_version_increment';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1 FROM advance_request_transitions t WHERE t.from_status = OLD.status AND t.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'La solicitud % no puede pasar de % a %.', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'advance_requests_transition_allowed';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER advance_requests_guard
  BEFORE UPDATE ON advance_requests
  FOR EACH ROW EXECUTE FUNCTION advance_requests_guard();

-- Al confirmar la transacción que la creó, la solicitud está completa. Relee la fila porque la
-- misma transacción pudo cambiarla después del INSERT.
CREATE FUNCTION advance_requests_complete() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  request record;
  invoice_total integer;
  net_pending_sum numeric;
  earliest date;
  consent_types integer;
BEGIN
  SELECT r.invoice_count, r.earliest_due_date, r.total_net_pending INTO request
  FROM advance_requests r WHERE r.id = NEW.id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT count(*), sum(i.net_pending_amount) INTO invoice_total, net_pending_sum
  FROM invoices i WHERE i.advance_request_id = NEW.id;
  IF invoice_total = 0 THEN
    RAISE EXCEPTION 'La solicitud % no tiene facturas.', NEW.id
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'advance_requests_complete';
  END IF;
  IF invoice_total <> request.invoice_count THEN
    RAISE EXCEPTION 'La solicitud % declara % facturas y tiene %.', NEW.id, request.invoice_count, invoice_total
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'advance_requests_complete';
  END IF;
  IF net_pending_sum <> request.total_net_pending THEN
    RAISE EXCEPTION 'El neto pendiente de la solicitud % no es la suma del de sus facturas.', NEW.id
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'advance_requests_complete';
  END IF;

  SELECT min(ii.due_date) INTO earliest
  FROM invoice_installments ii JOIN invoices i ON i.id = ii.invoice_id
  WHERE i.advance_request_id = NEW.id;
  IF earliest IS DISTINCT FROM request.earliest_due_date THEN
    RAISE EXCEPTION 'La fecha más próxima de la solicitud % no es la de su primera cuota.', NEW.id
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'advance_requests_complete';
  END IF;

  SELECT count(DISTINCT c.type) INTO consent_types FROM consents c WHERE c.advance_request_id = NEW.id;
  IF consent_types <> 2 THEN
    RAISE EXCEPTION 'La solicitud % no tiene los dos consentimientos.', NEW.id
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'advance_requests_complete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM status_history h
    WHERE h.advance_request_id = NEW.id AND h.from_status IS NULL AND h.to_status = 'NEW' AND h.version = 1
  ) THEN
    RAISE EXCEPTION 'La solicitud % no tiene su historial inicial.', NEW.id
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'advance_requests_complete';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER advance_requests_complete
  AFTER INSERT ON advance_requests
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION advance_requests_complete();

-- De una factura solo cambia request_status (lo copia ON UPDATE CASCADE de invoices_request_scope_fkey)
-- y updated_at.
CREATE FUNCTION invoices_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (to_jsonb(NEW) - 'request_status' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'request_status' - 'updated_at') THEN
    RAISE EXCEPTION 'De la factura % solo puede cambiar su estado.', OLD.id
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'invoices_immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER invoices_guard
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoices_guard();

CREATE FUNCTION stored_files_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.id, NEW.storage_bucket, NEW.key, NEW.purpose, NEW.content_type, NEW.size_bytes, NEW.sha256, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.storage_bucket, OLD.key, OLD.purpose, OLD.content_type, OLD.size_bytes, OLD.sha256, OLD.created_at) THEN
    RAISE EXCEPTION 'La identidad del archivo % no se puede modificar.', OLD.id
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'stored_files_identity_immutable';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT ((OLD.status = 'PENDING' AND NEW.status IN ('ATTACHED', 'DELETED'))
              OR (OLD.status = 'ATTACHED' AND NEW.status = 'DELETED')) THEN
    RAISE EXCEPTION 'El archivo % no puede pasar de % a %.', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'stored_files_status_transition';
  END IF;
  IF OLD.purged_at IS NOT NULL AND NEW.purged_at IS DISTINCT FROM OLD.purged_at THEN
    RAISE EXCEPTION 'El archivo % ya se purgó.', OLD.id
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'stored_files_purged_at_immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER stored_files_guard
  BEFORE UPDATE ON stored_files
  FOR EACH ROW EXECUTE FUNCTION stored_files_guard();

-- Solo inserción. La purga por retención (futura) borrará desde una función SECURITY DEFINER que
-- fija SET LOCAL app.retention_purge = 'on'. De un consentimiento solo cambia revoked_at, una vez.
CREATE FUNCTION reject_append_only_mutation() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.retention_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  IF TG_TABLE_NAME = 'consents' AND TG_OP = 'UPDATE' THEN
    IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
       AND (to_jsonb(NEW) - 'revoked_at') = (to_jsonb(OLD) - 'revoked_at') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'La tabla % es de solo inserción.', TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = TG_TABLE_NAME || '_append_only';
END
$$;

CREATE TRIGGER status_history_append_only
  BEFORE UPDATE OR DELETE ON status_history
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE TRIGGER consents_append_only
  BEFORE UPDATE OR DELETE ON consents
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

-- Un evento PUBLISHED no cambia y es lo único que se borra (purga); su identidad nunca cambia.
CREATE FUNCTION outbox_events_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'PUBLISHED' THEN
      RAISE EXCEPTION 'Solo se borran eventos publicados; % está en %.', OLD.id, OLD.status
        USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'outbox_events_delete_published_only';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'PUBLISHED' THEN
    RAISE EXCEPTION 'El evento % ya se publicó y no cambia.', OLD.id
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'outbox_events_published_immutable';
  END IF;
  IF (NEW.id, NEW.handler, NEW.dedupe_key, NEW.event_type, NEW.payload, NEW.advance_request_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.handler, OLD.dedupe_key, OLD.event_type, OLD.payload, OLD.advance_request_id, OLD.created_at) THEN
    RAISE EXCEPTION 'La identidad del evento % no se puede modificar.', OLD.id
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'outbox_events_identity_immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER outbox_events_guard
  BEFORE UPDATE OR DELETE ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION outbox_events_guard();

COMMIT;
