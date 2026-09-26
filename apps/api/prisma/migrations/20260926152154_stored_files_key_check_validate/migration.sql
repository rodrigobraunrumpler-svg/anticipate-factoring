-- Valida en su propia migración la CHECK que stored_files_key_check agregó NOT VALID
-- (docs/database/migrations.md, regla 5): ya rige para las filas nuevas; esta confirma que las
-- existentes también la cumplen, con un lock ligero (no ACCESS EXCLUSIVE).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE stored_files VALIDATE CONSTRAINT stored_files_key_check;

COMMIT;
