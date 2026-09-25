# Migraciones de la base

La base es PostgreSQL 18 (Neon en staging y producción, Docker Compose en local y en CI). El esquema
vive en `apps/api/prisma/schema.prisma` y cada cambio llega como una carpeta
`apps/api/prisma/migrations/<timestamp>_<nombre>/migration.sql` que se revisa y se versiona. La CLI
de Prisma (7.10.0 exacto) lee `apps/api/prisma.config.ts`.

## URLs que usa la CLI

| Variable | Para qué |
|---|---|
| `DATABASE_DIRECT_URL` | La que usa la CLI siempre que existe. En producción es obligatoria: `DATABASE_URL` pasa por el pooler de Neon (PgBouncer en modo transacción) y una migración nunca va por el pooler. |
| `DATABASE_URL` | La de la app. La CLI la usa solo fuera de producción y si falta la directa. |
| `SHADOW_DATABASE_URL` | Base desechable (`anticipate_shadow` en local) para `migrate dev` y `db:check-drift`. Prisma la vacía cada vez: nunca puede ser la misma base que se migra. |

## Comandos

| Comando | Qué hace |
|---|---|
| `pnpm db:generate` | Genera el cliente en `apps/api/src/infrastructure/prisma/generated/` (ignorado por git). |
| `pnpm --filter @anticipate/api db:migrate:create --name <nombre> < /dev/null` | Genera la migración de un cambio del esquema **sin aplicarla**, para revisarla y envolverla. |
| `pnpm db:migrate --name <nombre> < /dev/null` | Aplica en la base local las migraciones pendientes (y crea una si el esquema cambió). |
| `pnpm --filter @anticipate/api db:migrate:deploy` | Aplica las pendientes sin generar nada: es lo único que corre en CI, en los tests y en producción. |
| `pnpm db:check-drift` | Sale con código 0 si aplicar todas las migraciones da exactamente el esquema; si no, muestra la diferencia y sale con 2. |
| `pnpm db:seed` | Datos de ejemplo para desarrollo local (se niega a correr contra una base remota o con `NODE_ENV=production`). |

`< /dev/null` hace que `migrate dev` corra sin preguntar. Nunca se usa `prisma migrate reset`: para
empezar de cero en local, `pnpm infra:reset && pnpm infra:up` y luego `pnpm db:migrate`. Si
`migrate dev` se niega a generar sin interacción, se genera el SQL con
`pnpm --filter @anticipate/api exec prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --script -o prisma/migrations/<timestamp>_<nombre>/migration.sql`.

## Flujo de un cambio

1. Cambiar `schema.prisma`.
2. `pnpm --filter @anticipate/api db:migrate:create --name <nombre> < /dev/null`.
3. Revisar el SQL generado (regla 6) y envolverlo en la transacción (regla 1).
4. `pnpm db:migrate --name <nombre> < /dev/null` para aplicarlo en local.
5. `pnpm db:check-drift` debe salir con código 0.
6. Commit del esquema y de la carpeta de la migración juntos. Una migración ya aplicada en algún
   entorno no se edita nunca: se corrige con otra.

## Reglas

1. **Transacción explícita.** Toda migración empieza con

   ```sql
   BEGIN;
   SET LOCAL lock_timeout = '5s';
   SET LOCAL statement_timeout = '60s';
   ```

   y termina con `COMMIT;`. Prisma 7.10 no envuelve las migraciones: una que falla a la mitad deja
   la base a medio aplicar y todo `migrate deploy` posterior se detiene hasta que alguien la
   resuelva a mano. `lock_timeout` evita que un `ALTER TABLE` que espera un bloqueo frene todas las
   consultas detrás de él. La única excepción son las migraciones con `CREATE INDEX CONCURRENTLY`,
   que no puede correr dentro de una transacción: van solas en su propio archivo, sin `BEGIN`.
2. **Un `ALTER TYPE <tipo> ADD VALUE` va en un archivo distinto** de cualquier CHECK, índice o `UPDATE`
   que use el valor nuevo: dentro de la misma transacción PostgreSQL lo rechaza ("unsafe use of new
   value").
3. **Un valor nuevo de enum exige dos versiones.** En la versión R1 la migración lo agrega y el
   código lo conoce, pero no lo escribe. En la R2 el código lo escribe. Un cliente de Prisma viejo
   que lee un valor que no conoce falla con P2023, y durante un despliegue conviven las dos
   versiones. En producción nunca se quita ni se renombra un valor: se marca obsoleto en
   `@anticipate/shared`.
4. **Quitar o renombrar una columna: expandir y contraer en tres versiones** (agregar la nueva y
   escribir en las dos; migrar los datos y leer la nueva; quitar la vieja). Un renombre solo de
   TypeScript se hace con `@map`, sin tocar la base. Si Prisma genera `DROP COLUMN` + `ADD COLUMN`
   para un renombre, se edita a `ALTER TABLE <tabla> RENAME COLUMN <vieja> TO <nueva>`: el `DROP` borra los datos y, en
   silencio, las CHECK de la columna.
5. **En tablas con datos, las restricciones nuevas se validan aparte:** `ADD CONSTRAINT <nombre> CHECK (<condición>) NOT VALID`
   en una migración y `VALIDATE CONSTRAINT` en otra (CHECK y FK). En PostgreSQL 18 también sirve
   para `NOT NULL`: `ALTER TABLE t ADD CONSTRAINT t_x_not_null NOT NULL x NOT VALID`.
6. **Revisar toda migración generada antes del commit**, buscando `DROP INDEX`, `DROP COLUMN`,
   `DROP TABLE`, `ALTER TYPE` y cambios de enum:

   ```bash
   grep -nE 'DROP (INDEX|COLUMN|TABLE)|ALTER TYPE' apps/api/prisma/migrations/*/migration.sql
   ```

   CI corre `pnpm db:check-drift`, el test de reglas de migración
   (`apps/api/test/integration/migrations.test.ts`) y el test estructural de la base.

## Qué va en el esquema y qué va en SQL a mano

- **En el esquema, siempre:** tablas, columnas, enums, FK y **todos los índices**, con `map:` y su
  nombre estable (parciales, BRIN, GIN con `gin_trgm_ops` y descendentes incluidos). Un índice
  escrito a mano en SQL es deriva: Prisma lo borra en la migración siguiente.
- **Predicados de los índices parciales** en la forma que PostgreSQL normaliza (`=`, `<>`,
  booleanos, `IS NOT NULL`, `col <> ALL (ARRAY['A'::tipo, 'B'::tipo])`); con otra forma
  (`NOT IN`, por ejemplo) `db:check-drift` detecta deriva aunque el índice sea el mismo.
- **Un índice parcial que consulta el query builder** tiene un predicado de booleanos o
  `IS NULL`/`IS NOT NULL` (`where: { closedAt: null }`). Prisma manda cada enum como
  `CAST($1::text AS tipo)` y el planificador no usa un índice cuyo predicado nombra un enum: esos
  parciales se consultan solo con `$queryRaw` y el literal escrito en el texto
  (`WHERE status = 'PENDING'`).
- **En SQL a mano**, dentro de la transacción de la regla 1: lo que Prisma no representa y por eso
  no borra ni compara. La extensión `pg_trgm` y la secuencia `advance_request_code_seq` van al
  principio de la migración `init`. Las funciones, las CHECK, los triggers, las filas de los
  catálogos y los parámetros de la base van en la migración `integrity`. Cada CHECK sobre datos que
  vienen de afuera tiene su regla gemela en `@anticipate/shared`, para que el usuario reciba 422 y
  nunca 503.
- **Toda FK tiene un índice no parcial** cuya primera columna es la primera de la FK (o un unique o
  una PK que la cubre). Las excepciones están en la lista blanca del test estructural.

## Producción

Las migraciones corren una sola vez por despliegue, antes de actualizar la API, con
`prisma migrate deploy` y `DATABASE_DIRECT_URL` (el rol dueño de las tablas, sin pooler). Si fallan,
el despliegue se detiene y la versión anterior sigue atendiendo: por eso cada migración tiene que ser
compatible con el código que ya está corriendo (reglas 3 y 4). `migrate dev`, `db:seed` y
`migrate reset` nunca corren fuera de local.
