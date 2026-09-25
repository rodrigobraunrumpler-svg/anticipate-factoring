-- Endurecimiento de integrity (Tarea 7, ronda de revisión 1). Tres huecos que dejaban un estado
-- imposible o financiaban la misma factura dos veces (D49): (1) js_length no medía lo mismo que
-- Zod 4, (2) el agregado solo se protegía al crearlo, (3) nada impedía insertar una solicitud que
-- ya empezara fuera de NEW/versión 1. Escrita a mano, igual que integrity.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 1. Zod 4 mide `.min()`/`.max()` en puntos de código Unicode (util.codePointLength en
--    zod/v4/core/checks.js), no en unidades UTF-16: js_length calculaba unidades UTF-16 y por eso
--    difería de Zod en cualquier texto con caracteres fuera del plano básico (emoji). char_length()
--    de PostgreSQL ya cuenta puntos de código (el texto se guarda como UTF-8, no como UTF-16): es
--    la función correcta y no hace falta ninguna función propia para esto.
ALTER TABLE payers
  DROP CONSTRAINT payers_legal_name_check,
  DROP CONSTRAINT payers_short_name_check,
  ADD CONSTRAINT payers_legal_name_check CHECK (char_length(js_trim(legal_name)) BETWEEN 3 AND 200) NOT VALID,
  ADD CONSTRAINT payers_short_name_check CHECK (char_length(js_trim(short_name)) BETWEEN 2 AND 40) NOT VALID;

CREATE OR REPLACE FUNCTION is_valid_payer_texts(texts jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  RETURN CASE
    WHEN jsonb_typeof(texts) <> 'object' THEN false
    ELSE (
      SELECT count(*) <= 30
        AND coalesce(bool_and(
          key ~ '^[a-z][a-zA-Z0-9]{0,39}$'
          AND jsonb_typeof(value) = 'string'
          AND char_length(js_trim(value #>> '{}')) <= 2000
        ), true)
      FROM jsonb_each(texts)
    )
  END;

-- Sin más dependientes (las dos CHECK de arriba y is_valid_payer_texts ya usan char_length).
DROP FUNCTION js_length(text);

-- 2. El agregado (advance_requests + sus facturas, cuotas, consentimientos e historial inicial)
--    solo se comprobaba completo al confirmar la transacción que crea la solicitud
--    (advance_requests_complete). Después de eso, nada volvía a comprobarlo: un INSERT de una
--    factura o una cuota sueltas rompía invoice_count/total_net_pending/earliest_due_date en
--    silencio. La regla se saca a una función y se llama también al insertar una factura o una
--    cuota, siempre diferida a la confirmación (una sola solicitud puede tener varias facturas
--    insertándose en la misma transacción).
CREATE FUNCTION assert_advance_request_complete(p_id uuid) RETURNS void
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
  FROM advance_requests r WHERE r.id = p_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT count(*), sum(i.net_pending_amount) INTO invoice_total, net_pending_sum
  FROM invoices i WHERE i.advance_request_id = p_id;
  IF invoice_total = 0 THEN
    RAISE EXCEPTION 'La solicitud % no tiene facturas.', p_id
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'advance_requests_complete';
  END IF;
  IF invoice_total <> request.invoice_count THEN
    RAISE EXCEPTION 'La solicitud % declara % facturas y tiene %.', p_id, request.invoice_count, invoice_total
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'advance_requests_complete';
  END IF;
  IF net_pending_sum <> request.total_net_pending THEN
    RAISE EXCEPTION 'El neto pendiente de la solicitud % no es la suma del de sus facturas.', p_id
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'advance_requests_complete';
  END IF;

  SELECT min(ii.due_date) INTO earliest
  FROM invoice_installments ii JOIN invoices i ON i.id = ii.invoice_id
  WHERE i.advance_request_id = p_id;
  IF earliest IS DISTINCT FROM request.earliest_due_date THEN
    RAISE EXCEPTION 'La fecha más próxima de la solicitud % no es la de su primera cuota.', p_id
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'advance_requests_complete';
  END IF;

  SELECT count(DISTINCT c.type) INTO consent_types FROM consents c WHERE c.advance_request_id = p_id;
  IF consent_types <> 2 THEN
    RAISE EXCEPTION 'La solicitud % no tiene los dos consentimientos.', p_id
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'advance_requests_complete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM status_history h
    WHERE h.advance_request_id = p_id AND h.from_status IS NULL AND h.to_status = 'NEW' AND h.version = 1
  ) THEN
    RAISE EXCEPTION 'La solicitud % no tiene su historial inicial.', p_id
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'advance_requests_complete';
  END IF;
END
$$;

-- Mismo trigger de siempre (AFTER INSERT ON advance_requests, deferred); ahora delega en la
-- función compartida.
CREATE OR REPLACE FUNCTION advance_requests_complete() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM assert_advance_request_complete(NEW.id);
  RETURN NULL;
END
$$;

CREATE FUNCTION invoices_complete() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM assert_advance_request_complete(NEW.advance_request_id);
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER invoices_complete
  AFTER INSERT ON invoices
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION invoices_complete();

CREATE FUNCTION invoice_installments_complete() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  v_request_id uuid;
BEGIN
  SELECT i.advance_request_id INTO v_request_id FROM invoices i WHERE i.id = NEW.invoice_id;
  IF v_request_id IS NOT NULL THEN
    PERFORM assert_advance_request_complete(v_request_id);
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER invoice_installments_complete
  AFTER INSERT ON invoice_installments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION invoice_installments_complete();

-- Cerrar los otros dos caminos que dejaban editar el agregado ya confirmado: borrar una factura
-- (liberaría la clave de una factura ya desembolsada: doble financiamiento) o tocar una cuota
-- (rompería earliest_due_date sin que ningún INSERT lo vuelva a comprobar). Mismo escape de
-- purga por retención que las tablas de solo inserción.
CREATE OR REPLACE FUNCTION invoices_guard() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.retention_purge', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'La factura % no se puede borrar.', OLD.id
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'invoices_delete_restricted';
  END IF;
  IF (to_jsonb(NEW) - 'request_status' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'request_status' - 'updated_at') THEN
    RAISE EXCEPTION 'De la factura % solo puede cambiar su estado.', OLD.id
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'invoices_immutable';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER invoices_guard ON invoices;
CREATE TRIGGER invoices_guard
  BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoices_guard();

CREATE TRIGGER invoice_installments_append_only
  BEFORE UPDATE OR DELETE ON invoice_installments
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

-- 3. Nada comprobaba el estado inicial al insertar: un script podía crear una solicitud ya
--    APPROVED con versión 7, saltándose la máquina de estados por completo. advance_requests_guard
--    solo corre en UPDATE (necesita OLD); esta regla es la mitad que faltaba, en INSERT.
CREATE FUNCTION advance_requests_initial_state() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM 'NEW' OR NEW.version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'La solicitud % debe empezar en NEW con versión 1.', NEW.id
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'advance_requests_initial_state';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER advance_requests_initial_state
  BEFORE INSERT ON advance_requests
  FOR EACH ROW EXECUTE FUNCTION advance_requests_initial_state();

COMMIT;
