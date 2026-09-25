-- Endurecimiento de integrity, ronda 4 (Tarea 7, revisión de fix round 3). Sigue D49: ninguna vía
-- puede guardar un estado imposible ni financiar dos veces una factura; el agregado queda completo
-- en el COMMIT que lo crea y no cambia después.
-- La carrera: invoice_installments_same_transaction era un trigger BEFORE INSERT que leía el
-- creating_xact_id de la factura y solo rechazaba si era distinto de pg_current_xact_id(); si no
-- encontraba la factura, dejaba pasar la cuota para que fallara la FK. En READ COMMITTED, una
-- transacción B podía insertar una cuota para la factura que otra transacción A acababa de insertar
-- y todavía no confirmaba: la factura era invisible para B, la lectura daba NULL y el gate pasaba.
-- Si A confirmaba antes de que terminara la sentencia de B, la FK (que se comprueba al terminar la
-- sentencia, con una foto nueva) ya encontraba la factura, y el trigger diferido
-- assert_advance_request_complete no suma las cuotas: B confirmaba y dejaba una cuota ajena pegada a
-- la factura ya confirmada de A (reproducido: cuota 2 de 100.00 sobre una factura de neto 10620.00,
-- suma 10720.00).
-- El arreglo: el mismo gate, con el mismo nombre, pasa a AFTER INSERT ... FOR EACH ROW (no diferido),
-- que corre al terminar la sentencia, y una factura que no se encuentra también es una violación.
-- La función es VOLATILE, así que en READ COMMITTED su consulta toma una foto nueva en ese momento:
-- si A ya confirmó, la factura se ve con el creating_xact_id de A, distinto del de B, y se rechaza;
-- si A todavía no confirmó, la factura no se ve y se rechaza (la FK también la rechaza). En
-- REPEATABLE READ y SERIALIZABLE la foto de la transacción no ve la factura de A: hoy la rechaza
-- antes la FK (en esos aislamientos consulta con esa misma foto, y corre primero porque los
-- triggers de una tabla corren por orden de nombre y los de la FK empiezan con "RI_"), y el gate la
-- rechazaría igual.
-- La factura propia (en la misma transacción, bajo un SAVEPOINT, dentro de un bloque EXCEPTION de
-- PL/pgSQL, o en la misma sentencia con CTE que insertan la factura y sus cuotas juntas) se ve con el
-- mismo creating_xact_id y se acepta. El SQLSTATE y el nombre de la regla no cambian, así que el
-- mapeo de errores de la API tampoco. Escrita a mano, igual que las anteriores.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- VOLATILE a propósito (es el valor por defecto; se deja explícito porque la regla depende de él):
-- una función STABLE o IMMUTABLE reusaría la foto de la sentencia y no vería la factura que otra
-- transacción confirmó mientras la sentencia corría.
CREATE OR REPLACE FUNCTION invoice_installments_same_transaction() RETURNS trigger
  LANGUAGE plpgsql
  VOLATILE
AS $$
DECLARE
  invoice_creating_xact_id xid8;
BEGIN
  SELECT i.creating_xact_id INTO invoice_creating_xact_id FROM invoices i WHERE i.id = NEW.invoice_id;
  -- Sin factura visible al terminar la sentencia: o no existe, o es de otra transacción que todavía
  -- no confirma (READ COMMITTED), o la foto de la transacción no la ve (REPEATABLE READ o
  -- SERIALIZABLE). En ningún caso es una factura creada por esta transacción: se rechaza aquí, sin
  -- depender de que la FK lo haga primero.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La cuota % no se puede agregar: la factura % no es visible para esta transacción.', NEW.id, NEW.invoice_id
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'invoice_installments_same_transaction';
  END IF;
  IF invoice_creating_xact_id <> pg_current_xact_id() THEN
    RAISE EXCEPTION 'La cuota % no se puede agregar: la factura % es de otra transacción.', NEW.id, NEW.invoice_id
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'invoice_installments_same_transaction';
  END IF;
  RETURN NULL;
END
$$;

-- AFTER ROW normal, no un constraint trigger: corre al terminar cada sentencia (junto con la FK) y
-- ni SET CONSTRAINTS ni un DEFERRABLE lo pueden postergar hasta el COMMIT.
DROP TRIGGER invoice_installments_same_transaction ON invoice_installments;
CREATE TRIGGER invoice_installments_same_transaction
  AFTER INSERT ON invoice_installments
  FOR EACH ROW EXECUTE FUNCTION invoice_installments_same_transaction();

COMMIT;
