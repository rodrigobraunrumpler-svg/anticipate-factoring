-- Endurecimiento de integrity, ronda 3 (Tarea 7, revisión de fix round 2). Sigue D49: ninguna vía
-- puede liberar la clave de una factura viva o desembolsada, ni alterar un agregado ya confirmado.
-- (b) El gate de la ronda 2 (xmin) tenía dos fallas: xmin es quien escribió la última versión de la
--     fila, no quien la creó (un UPDATE sin cambios, que invoices_guard deja pasar, ya "tocaba" la
--     factura y volvía a abrir la ventana), y dentro de un SAVEPOINT (los `$transaction` anidados de
--     Prisma, o un bloque EXCEPTION de PL/pgSQL) xmin es el xid de la subtransacción mientras
--     pg_current_xact_id() sigue siendo el de la transacción de nivel superior: eso rechazaba altas
--     legítimas. Se reemplaza por la columna invoices.creating_xact_id (migración
--     invoice_creating_xact_id), congelada al crear la factura y comparada siempre contra
--     pg_current_xact_id(), nunca contra xmin.
-- Purga parcial de los hermanos de un agregado vivo: con la purga por retención encendida se podían
-- borrar las cuotas de una factura viva, o los consentimientos y el historial de una solicitud viva,
-- sin borrar la factura o la solicitud dueña. Mismo patrón que invoices_purge_requires_request_purge
-- (ronda 2, hallazgo a): un constraint trigger diferido que exige que el padre también se haya
-- borrado en la misma transacción.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- (b) La factura fuerza su propio creating_xact_id al insertarse (ignora cualquier valor que venga
-- de fuera, por si alguna vez alguien intenta insertar por SQL directo con uno propio); el DEFAULT
-- de la columna ya lo pone bien, pero este trigger es quien manda.
CREATE FUNCTION invoices_set_creating_xact_id() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.creating_xact_id := pg_current_xact_id();
  RETURN NEW;
END
$$;

CREATE TRIGGER invoices_set_creating_xact_id
  BEFORE INSERT ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoices_set_creating_xact_id();

-- invoices_guard (ya existente) congela creating_xact_id sin cambiarla: su diff con to_jsonb(NEW)/
-- to_jsonb(OLD) recorre toda la fila salvo request_status y updated_at, y to_jsonb sabe convertir
-- xid8 (se serializa como el número en texto), así que cualquier intento de UPDATE sobre esta
-- columna ya cae en 'invoices_immutable' sin tocar esa función.

-- Ya no compara contra xmin (quien escribió la última versión de la factura), sino contra
-- creating_xact_id (quien la creó, congelada por invoices_set_creating_xact_id e invoices_guard):
-- pg_current_xact_id() es el mismo valor dentro o fuera de un SAVEPOINT, así que esta comparación
-- funciona igual con `$transaction` anidados de Prisma o dentro de un bloque EXCEPTION de PL/pgSQL.
CREATE OR REPLACE FUNCTION invoice_installments_same_transaction() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  invoice_creating_xact_id xid8;
BEGIN
  SELECT i.creating_xact_id INTO invoice_creating_xact_id FROM invoices i WHERE i.id = NEW.invoice_id;
  -- Sin factura (invoice_creating_xact_id NULL): no es esta regla la que debe fallar, sino la FK al
  -- terminar la sentencia (o la CHECK de la fila, si además rompe otra).
  IF invoice_creating_xact_id IS NOT NULL AND invoice_creating_xact_id <> pg_current_xact_id() THEN
    RAISE EXCEPTION 'La cuota % no se puede agregar: la factura % es de otra transacción.', NEW.id, NEW.invoice_id
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'invoice_installments_same_transaction';
  END IF;
  RETURN NEW;
END
$$;

-- Purga parcial: borrar solo las cuotas de una factura viva (o solo un consentimiento o la fila
-- inicial del historial de una solicitud viva), con la purga por retención encendida, dejaba la
-- factura con cero cuotas o la solicitud sin sus consentimientos o su historial. Mismo patrón que
-- invoices_purge_requires_request_purge: el padre tiene que haberse borrado en la misma transacción.

CREATE FUNCTION invoice_installments_purge_requires_invoice_purge() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM invoices i WHERE i.id = OLD.invoice_id) THEN
    RAISE EXCEPTION 'La cuota % se borró sin borrar la factura % en la misma transacción.', OLD.id, OLD.invoice_id
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'invoice_installments_purge_requires_invoice_purge';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER invoice_installments_purge_requires_invoice_purge
  AFTER DELETE ON invoice_installments
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION invoice_installments_purge_requires_invoice_purge();

CREATE FUNCTION consents_purge_requires_request_purge() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM advance_requests r WHERE r.id = OLD.advance_request_id) THEN
    RAISE EXCEPTION 'El consentimiento % se borró sin borrar la solicitud % en la misma transacción.', OLD.id, OLD.advance_request_id
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'consents_purge_requires_request_purge';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER consents_purge_requires_request_purge
  AFTER DELETE ON consents
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION consents_purge_requires_request_purge();

CREATE FUNCTION status_history_purge_requires_request_purge() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM advance_requests r WHERE r.id = OLD.advance_request_id) THEN
    RAISE EXCEPTION 'El historial % se borró sin borrar la solicitud % en la misma transacción.', OLD.id, OLD.advance_request_id
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'status_history_purge_requires_request_purge';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER status_history_purge_requires_request_purge
  AFTER DELETE ON status_history
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION status_history_purge_requires_request_purge();

COMMIT;
