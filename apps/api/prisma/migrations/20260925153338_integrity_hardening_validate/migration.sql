-- Valida en su propia migración las dos CHECK que integrity_hardening agregó NOT VALID
-- (docs/database/migrations.md, regla 5): payers_legal_name_check y payers_short_name_check ya
-- rigen para las filas nuevas desde esa migración; esta solo confirma que las filas existentes
-- también las cumplen, con un lock ligero (no ACCESS EXCLUSIVE).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE payers VALIDATE CONSTRAINT payers_legal_name_check;
ALTER TABLE payers VALIDATE CONSTRAINT payers_short_name_check;

COMMIT;
