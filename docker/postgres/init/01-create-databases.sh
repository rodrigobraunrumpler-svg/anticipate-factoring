#!/bin/bash
# La imagen de PostgreSQL lo corre una sola vez, al crear el volumen de datos (`pnpm infra:reset` lo borra).
#   anticipate_test:   tests de integración (`prisma migrate deploy` en cada corrida, `TRUNCATE` entre tests).
#   anticipate_shadow: base sombra de `prisma migrate dev` y de `pnpm db:check-drift`; Prisma la vacía en cada uso.
set -euo pipefail

for database in anticipate_test anticipate_shadow; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    --command "CREATE DATABASE \"${database}\" OWNER \"${POSTGRES_USER}\";"
done
