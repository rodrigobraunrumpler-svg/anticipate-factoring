-- Quita status_history_one_initial_key (revisión final del paso 2, D40). Era redundante: la CHECK
-- status_history_initial_check ((from_status IS NULL) = (version = 1), validada y con version NOT
-- NULL) hace que toda fila inicial sea la versión 1, y status_history_advance_request_id_version_key
-- admite una sola versión 1 por solicitud. Y era peligroso: Prisma exponía el índice parcial como
-- findUnique({ where: { advanceRequestId } }), que ignora el predicado y devuelve una fila cualquiera
-- del historial. Generada con `prisma migrate diff` y envuelta a mano (regla 1).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- DropIndex
DROP INDEX "status_history_one_initial_key";

COMMIT;
