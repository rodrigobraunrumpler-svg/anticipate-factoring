-- stored_files.key cumple la misma regla que el adaptador de almacenamiento (objectKeyProblem en
-- apps/api/src/infrastructure/storage/s3/s3-file-storage.adapter.ts, revisión final del paso 2).
-- Con una clave vacía el SDK de S3 arma la ruta del bucket y la operación deja de ser sobre un objeto
-- (DeleteObject borra el bucket, un GetObject firmado lista todas sus claves); un segmento vacío, "."
-- o ".." es una ruta que un proxy o el proveedor pueden normalizar hacia otra clave. El adaptador ya
-- se niega a mandarlas; esta CHECK impide además guardarlas, venga la fila de donde venga (la API, un
-- script o el admin futuro), así ninguna queda pendiente para siempre en la purga.
-- Reglas, en el orden de objectKeyProblem: no vacía; sin caracteres de control (C0, DEL y C1, los
-- \p{Cc} de JS; U+0000 y los surrogates sueltos ya no caben en un texto UTF-8 de PostgreSQL); a lo
-- sumo 1024 bytes en UTF-8 (el tope de S3 y R2: la columna VARCHAR(512) cuenta caracteres, y 512 de
-- hasta 4 bytes pasan de 1024); sin "/" inicial; sin segmentos vacíos ("//" o "/" al final); sin
-- segmentos "." ni "..". Las reglas espejo se prueban contra objectKeyProblem en
-- test/integration/database-structure.test.ts.
-- Regla 5 de docs/database/migrations.md: NOT VALID aquí y VALIDATE en la migración siguiente.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE stored_files
  ADD CONSTRAINT stored_files_key_check CHECK (
    key <> ''
    AND key !~ '[\u0001-\u001f\u007f-\u009f]'
    AND octet_length(key) <= 1024
    AND left(key, 1) <> '/'
    AND position('//' IN key) = 0
    AND right(key, 1) <> '/'
    AND key !~ '(^|/)\.\.?(/|$)'
  ) NOT VALID;

COMMIT;
