-- Fija el search_path de toda función PL/pgSQL de la base (Tarea 7, revisión de integrity_hardening_4).
-- Sigue D49: ninguna vía puede guardar un estado imposible ni financiar dos veces una factura.
-- El hueco: las funciones de los triggers nombran las tablas sin esquema (`FROM invoices i`) y no
-- fijaban su search_path. PL/pgSQL resuelve esos nombres al correr, con el search_path vigente, y
-- PostgreSQL busca un nombre de relación (o de tipo) primero en el esquema temporal de la sesión
-- (pg_temp) siempre que el search_path no nombre pg_temp. TEMP se concede a PUBLIC por defecto, así
-- que cualquier rol que pudiera insertar tapaba la tabla que lee un trigger con una tabla temporal
-- del mismo nombre y filas falsas, y el trigger leía esas filas; la FK no se enteraba, porque sus
-- consultas nombran public.<tabla>. Reproducido también como un rol sin superusuario, con solo
-- SELECT e INSERT: una tabla temporal `invoices` abría el gate de las cuotas (una cuota ajena sobre
-- una factura ya confirmada, suma 10720.00 contra un neto de 10620.00) y una `advance_requests`
-- dejaba confirmar una segunda factura en una solicitud que declara una. Lo mismo servía contra la
-- máquina de estados (`advance_request_transitions`) y las reglas diferidas de la purga.
-- El arreglo: cada función PL/pgSQL fija search_path = pg_catalog, public, pg_temp. pg_catalog va
-- primero (ninguna tabla ni tipo de la base tapa uno del sistema) y pg_temp va nombrado y al final:
-- nombrarlo es lo único que evita que se busque primero; `pg_catalog, public` solo no basta. No
-- cambia ningún cuerpo, SQLSTATE ni nombre de regla. Las funciones SQL de integrity (js_trim,
-- is_valid_ruc, is_valid_payer_texts, canonical_invoice_key, uuidv7_floor) no lo necesitan: tienen
-- cuerpo estándar (RETURN), que PostgreSQL guarda con los nombres ya resueltos al crearlas.
-- Un CREATE OR REPLACE FUNCTION que no repita el SET lo borra: toda función PL/pgSQL nueva o
-- reemplazada lo lleva en su definición (docs/database/migrations.md), y el test estructural lo exige
-- en todas las funciones de la base.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- integrity
ALTER FUNCTION set_updated_at() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION advance_requests_guard() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION invoices_guard() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION stored_files_guard() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION reject_append_only_mutation() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION outbox_events_guard() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION advance_requests_complete() SET search_path = pg_catalog, public, pg_temp;

-- integrity_hardening
ALTER FUNCTION assert_advance_request_complete(uuid) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION invoices_complete() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION invoice_installments_complete() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION advance_requests_initial_state() SET search_path = pg_catalog, public, pg_temp;

-- integrity_hardening_2
ALTER FUNCTION invoices_purge_requires_request_purge() SET search_path = pg_catalog, public, pg_temp;

-- integrity_hardening_3
ALTER FUNCTION invoices_set_creating_xact_id() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION invoice_installments_purge_requires_invoice_purge() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION consents_purge_requires_request_purge() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION status_history_purge_requires_request_purge() SET search_path = pg_catalog, public, pg_temp;

-- integrity_hardening_4
ALTER FUNCTION invoice_installments_same_transaction() SET search_path = pg_catalog, public, pg_temp;

-- Ninguna función PL/pgSQL de la base, fuera de las de una extensión, puede quedar sin el search_path
-- fijo: si una migración anterior agregó una que esta lista no nombra, la migración se detiene aquí
-- y no se aplica nada.
DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.proname) INTO missing
  FROM pg_proc p
  JOIN pg_language l ON l.oid = p.prolang
  WHERE p.pronamespace = 'public'::regnamespace
    AND l.lanname = 'plpgsql'
    AND p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
    AND NOT EXISTS (
      SELECT 1 FROM pg_depend d
      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
    );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Funciones PL/pgSQL sin search_path fijo: %.', missing;
  END IF;
END
$$;

COMMIT;
