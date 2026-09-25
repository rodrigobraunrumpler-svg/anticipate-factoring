-- La transacción que creó una factura se identifica por su xid y por el instante en que empezó
-- (Tarea 7, revisión de pin_function_search_path). Sigue D49: ninguna vía puede agregar una cuota a
-- una factura creada por otra transacción.
-- El hueco: invoice_installments_same_transaction comparaba solo invoices.creating_xact_id con
-- pg_current_xact_id(). Un xid8 nunca se repite dentro de un clúster, pero una copia lógica lleva los
-- creating_xact_id del clúster de origen tal cual: pg_dump escribe los datos antes de crear los
-- triggers (van después de los datos), y el worker de la replicación lógica corre con
-- session_replication_role = replica. Un clúster nuevo empieza cerca del xid 750, así que cada
-- factura copiada trae un xid futuro: cualquier sesión con INSERT repetía `pg_current_xact_id();
-- COMMIT` hasta que su xid coincidía con el de una factura y le agregaba una cuota. El gate veía el xid
-- que esperaba, la FK encontraba la factura y el trigger diferido del agregado no suma cuotas.
-- Reproducido con pg_dump y un clúster nuevo, como un rol sin superusuario con solo SELECT e INSERT:
-- una cuota ajena confirmada sobre una factura de neto 10620.00, suma 10720.00. Es anterior a
-- integrity_hardening_4 (la comparación viene de integrity_hardening_3). Pasa lo mismo con cualquier
-- copia lógica hacia una base cuyo contador de xid va por detrás: un clúster nuevo, una rama o una
-- restauración a un punto anterior, que comparten el contador solo hasta donde se separaron.
-- El arreglo: la factura guarda también creating_xact_start, el transaction_timestamp() de la
-- transacción que la creó (con microsegundos). invoices_set_creating_xact_id lo fuerza al insertar,
-- igual que el xid (ignora el valor del cliente), e invoices_guard ya lo congela: su diff con
-- to_jsonb(NEW)/to_jsonb(OLD) recorre toda la fila salvo request_status y updated_at. El gate exige
-- los dos valores. La transacción que creó la factura empezó antes de cualquier copia de esa factura,
-- así que ninguna transacción posterior a la copia empieza en ese instante, aunque reciba el mismo
-- xid. Supone relojes sincronizados (NTP): solo un clúster de destino cuyo reloj atrasara, respecto
-- del de origen, más de lo que tardó la copia volvería a pasar por ese instante. No hace falta ningún
-- paso manual después de una restauración. Dentro de la transacción,
-- transaction_timestamp() no cambia (tampoco bajo un SAVEPOINT ni en un bloque EXCEPTION de
-- PL/pgSQL), así que las altas legítimas se aceptan igual que antes. El SQLSTATE, el nombre de la
-- regla y sus mensajes no cambian, así que el mapeo de errores de la API tampoco.
-- Las facturas que ya existían reciben el transaction_timestamp() de esta migración. No es el
-- instante en que se crearon, pero ninguna transacción posterior a esta migración empieza en él, y su
-- creating_xact_id es de una transacción ya terminada: el gate las sigue rechazando para todos.
-- El ALTER TABLE es el que genera Prisma. Lo demás está escrito a mano, como en las anteriores, con el
-- search_path fijo de pin_function_search_path (un CREATE OR REPLACE que no lo repite lo borra).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "creating_xact_start" TIMESTAMPTZ(6) NOT NULL DEFAULT transaction_timestamp();

-- La factura fuerza los dos valores de la transacción que la crea. El DEFAULT de las columnas ya los
-- pone bien, pero este trigger es quien manda.
CREATE OR REPLACE FUNCTION invoices_set_creating_xact_id() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  NEW.creating_xact_id := pg_current_xact_id();
  NEW.creating_xact_start := transaction_timestamp();
  RETURN NEW;
END
$$;

-- VOLATILE a propósito, como en integrity_hardening_4: en READ COMMITTED la consulta toma una foto
-- nueva al terminar la sentencia y ve la factura que otra transacción confirmó mientras corría.
CREATE OR REPLACE FUNCTION invoice_installments_same_transaction() RETURNS trigger
  LANGUAGE plpgsql
  VOLATILE
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  invoice_creating_xact_id xid8;
  invoice_creating_xact_start timestamptz;
BEGIN
  SELECT i.creating_xact_id, i.creating_xact_start
    INTO invoice_creating_xact_id, invoice_creating_xact_start
    FROM invoices i WHERE i.id = NEW.invoice_id;
  -- Sin factura visible al terminar la sentencia: o no existe, o es de otra transacción que todavía
  -- no confirma (READ COMMITTED), o la foto de la transacción no la ve (REPEATABLE READ o
  -- SERIALIZABLE). En ningún caso es una factura creada por esta transacción.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La cuota % no se puede agregar: la factura % no es visible para esta transacción.', NEW.id, NEW.invoice_id
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'invoice_installments_same_transaction';
  END IF;
  -- El xid solo no basta: una factura copiada de otro clúster puede traer el xid de esta transacción.
  -- El instante en que empezó la transacción que la creó es anterior a la copia y ninguna transacción
  -- posterior empieza en él.
  IF invoice_creating_xact_id IS DISTINCT FROM pg_current_xact_id()
     OR invoice_creating_xact_start IS DISTINCT FROM transaction_timestamp() THEN
    RAISE EXCEPTION 'La cuota % no se puede agregar: la factura % es de otra transacción.', NEW.id, NEW.invoice_id
      USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'invoice_installments_same_transaction';
  END IF;
  RETURN NULL;
END
$$;

COMMIT;
