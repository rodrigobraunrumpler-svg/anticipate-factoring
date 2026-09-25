-- Endurecimiento de integrity, ronda 2 (Tarea 7, revisión de fix round 1). Dos caminos que
-- reabrían D49 (ninguna vía puede liberar la clave de una factura viva o desembolsada, ni alterar
-- un agregado ya confirmado):
-- (a) con la purga por retención encendida, una sesión podía borrar las facturas de una solicitud
--     DESEMBOLSADA sin borrar la solicitud, liberando la clave de esa factura (doble financiamiento).
-- (b) una cuota se podía insertar para una factura de una transacción anterior, mientras no moviera
--     earliest_due_date: el trigger diferido de la ronda 1 solo comprueba el agregado al confirmar,
--     no cuándo se creó la factura.
-- Escrita a mano, igual que las anteriores.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- (a) Borrar una factura (con la purga encendida) solo se acepta si su solicitud también se borró
-- en la misma transacción: constraint trigger diferido a la confirmación, para que el orden de los
-- DELETE (cuotas, facturas, ..., solicitud) no importe. Purgar el agregado entero sigue funcionando;
-- borrar solo las facturas y dejar la solicitud viva se rechaza al confirmar.
CREATE FUNCTION invoices_purge_requires_request_purge() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM advance_requests r WHERE r.id = OLD.advance_request_id) THEN
    RAISE EXCEPTION 'La factura % se borró sin borrar la solicitud % en la misma transacción.', OLD.id, OLD.advance_request_id
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'invoices_purge_requires_request_purge';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER invoices_purge_requires_request_purge
  AFTER DELETE ON invoices
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION invoices_purge_requires_request_purge();

-- (b) Una cuota solo se inserta en la misma transacción que insertó su factura: compara el xmin de
-- la factura (la transacción que escribió su última versión) con el id de la transacción en curso.
-- pg_current_xact_id() (xid8, PostgreSQL 13+) no tiene la ambigüedad de xmin (xid, 32 bits) al
-- comparar con un xid arbitrario de hace mucho, pero eso no aplica aquí: solo se compara contra la
-- transacción que se está ejecutando ahora mismo, que por definición no pudo haber dado la vuelta
-- respecto de sí misma, así que el truncado a 32 bits (xid8::xid) es exacto para esta comprobación
-- ("¿escribió esta fila la transacción en curso?"), sin importar cuántas transacciones hayan corrido
-- antes en la vida de la base. No es diferido: la transacción en curso no cambia entre el INSERT y
-- la confirmación, así que no hace falta esperar.
CREATE FUNCTION invoice_installments_same_transaction() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  invoice_xmin xid;
BEGIN
  SELECT i.xmin INTO invoice_xmin FROM invoices i WHERE i.id = NEW.invoice_id;
  -- Sin factura (invoice_xmin NULL): no es esta regla la que debe fallar, sino la FK al terminar
  -- la sentencia (o la CHECK de la fila, si además rompe otra).
  IF invoice_xmin IS NOT NULL AND invoice_xmin <> pg_current_xact_id()::xid THEN
    RAISE EXCEPTION 'La cuota % no se puede agregar: la factura % es de otra transacción.', NEW.id, NEW.invoice_id
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'invoice_installments_same_transaction';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER invoice_installments_same_transaction
  BEFORE INSERT ON invoice_installments
  FOR EACH ROW EXECUTE FUNCTION invoice_installments_same_transaction();

COMMIT;
