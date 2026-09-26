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
| `SHADOW_DATABASE_URL` | Base desechable (`anticipate_shadow` en local) para `migrate dev` y `db:check-drift`. Prisma la vacía cada vez: tiene que ser local, llevar `shadow` en el nombre y llamarse distinto de la base que se migra. |

`apps/api/prisma.config.ts` pasa las variables por la guarda de `apps/api/prisma/cli-guard.ts`
(probada en `cli-guard.test.ts`), que se niega a correr antes de conectarse si:

- la URL que usa la CLI o la sombra apuntan al pooler de Neon (un host `*-pooler`), en cualquier
  entorno;
- el comando no es `migrate deploy`, `migrate status`, `migrate resolve`, `migrate diff` ni `db seed`
  y la base no es local (`localhost`, `127.x.x.x`, `::1`, el servicio `postgres` de Compose o un
  socket Unix). Así `migrate dev`, `migrate reset` y `db push` nunca tocan una base remota, y
  tampoco un comando que la guarda no reconoce;
- la sombra no es local, su base no lleva `shadow` en el nombre, o se llama igual que la base que
  se migra (sin distinguir mayúsculas). Solo cuenta el nombre de la base, no el host ni el puerto:
  el mismo servidor se alcanza escrito de muchas formas (`localhost`, `127.0.0.1`, `127.1`, `::1`,
  un socket Unix, el nombre de la máquina, dos puertos de Docker hacia el mismo contenedor, un
  túnel), así que `postgresql://…@localhost:5433/anticipate` como sombra de
  `postgresql://…@127.0.0.1:5433/anticipate` se rechaza aunque los hosts se escriban distinto. El
  nombre sí es exacto: en un servidor, dos nombres distintos son dos bases distintas. Exigir
  `shadow` en el nombre impide además que la sombra sea otra base con datos (`anticipate` mientras
  se migra `anticipate_test`). Con sombra, la URL que se migra tiene que nombrar su base, y ninguna
  de las dos puede traerla en el parámetro `dbname`, que libpq usa en vez de la ruta.

El comando sale de los argumentos de la CLI sin depender de su posición (`prisma --config x migrate
dev` también es `migrate dev`). `generate`, `validate`, `format` y `version` no se conectan y reciben
una URL de relleno.

## Comandos

| Comando | Qué hace |
|---|---|
| `pnpm db:generate` | Genera el cliente en `apps/api/src/infrastructure/prisma/generated/` (ignorado por git). |
| `pnpm --filter @anticipate/api db:migrate:create --name <nombre> < /dev/null` | Genera la migración de un cambio del esquema **sin aplicarla**, para revisarla y envolverla. |
| `pnpm db:migrate --name <nombre> < /dev/null` | Aplica en la base local las migraciones pendientes (y crea una si el esquema cambió). |
| `pnpm --filter @anticipate/api db:migrate:deploy` | Aplica las pendientes sin generar nada: es lo único que corre en CI, en los tests y en producción. |
| `pnpm --filter @anticipate/api db:migrate:status` | Qué migraciones están aplicadas, pendientes o fallidas en la base de `DATABASE_DIRECT_URL`. No cambia nada. |
| `pnpm --filter @anticipate/api db:migrate:resolve --rolled-back <carpeta>` | Marca como deshecha una migración que falló, para que `migrate deploy` la vuelva a intentar (ver «Si una migración falla»). |
| `pnpm db:check-drift` | Sale con código 0 si aplicar todas las migraciones da exactamente el esquema; si no, muestra la diferencia y sale con 2. |
| `pnpm db:seed` | Datos de ejemplo para desarrollo local (se niega a correr contra una base remota o con `NODE_ENV=production`). |

Los scripts `db:*` de la raíz (`db:generate`, `db:migrate`, `db:seed` y `db:check-drift`) llaman a
los de `@anticipate/api` con `--fail-if-no-match`; `db:migrate:create`, `db:migrate:deploy`,
`db:migrate:status` y `db:migrate:resolve` se llaman con `pnpm --filter @anticipate/api`.

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
- **Toda función PL/pgSQL fija su `search_path`** en su definición:
  `SET search_path = pg_catalog, public, pg_temp`, también en cada `CREATE OR REPLACE FUNCTION`, que
  lo borra si no lo repite. PL/pgSQL resuelve los nombres al correr, y si el `search_path` no nombra
  `pg_temp`, PostgreSQL busca las tablas primero en el esquema temporal de la sesión: cualquier rol
  con `TEMP` (PUBLIC lo tiene por defecto) tapaba la tabla que lee un trigger con una tabla temporal
  del mismo nombre y se saltaba la regla. `pg_temp` va nombrado y al final; `pg_catalog, public` solo
  no basta. Las funciones SQL con cuerpo estándar (`RETURN` o `BEGIN ATOMIC`) resuelven sus nombres al
  crearse y no lo necesitan. El test estructural lo exige en todas las funciones de la base.
- **Un xid guardado en una fila no identifica una transacción fuera de su clúster.** Una copia
  lógica (`pg_dump` y su restauración, o la replicación lógica) lo lleva tal cual a una base cuyo
  contador de xid puede ir por detrás: un clúster nuevo, una rama o una restauración a un punto
  anterior. Allí otra transacción puede recibir ese mismo xid. Una regla que decide si una fila la
  creó la transacción en curso compara el xid (`pg_current_xact_id()`) y también el instante en que
  empezó esa transacción (`transaction_timestamp()`). Los dos los fuerza un trigger `BEFORE INSERT`
  y quedan congelados después, como `invoices.creating_xact_id` y `invoices.creating_xact_start`.
  El instante va en una columna `timestamptz(6)`: con menos precisión se redondea y la regla
  rechaza las filas de la propia transacción.

## Producción

Las migraciones corren una sola vez por despliegue, antes de actualizar la API, con
`prisma migrate deploy` y `DATABASE_DIRECT_URL` (el rol dueño de las tablas, sin pooler). Si fallan,
el despliegue se detiene y la versión anterior sigue atendiendo: por eso cada migración tiene que ser
compatible con el código que ya está corriendo (reglas 3 y 4). `migrate dev`, `db:seed` y
`migrate reset` nunca corren fuera de local: la guarda de la CLI se niega.

## Si una migración falla

Una migración envuelta en `BEGIN … COMMIT` (regla 1) que falla no deja nada a medias: PostgreSQL
deshace toda la transacción. Pero Prisma anota el intento en `_prisma_migrations` como fallido
(`finished_at` vacío) y todo `migrate deploy` posterior se detiene con `P3009` hasta resolverlo. Los
pasos, con la `DATABASE_DIRECT_URL` del entorno afectado:

1. **Ver cuál falló y por qué.** `pnpm --filter @anticipate/api db:migrate:status` muestra la
   migración fallida. Prisma 7.10 no muestra la causa: con una migración envuelta informa solo
   `current transaction is aborted, commands ignored until end of transaction block`, y la columna
   `logs` de `_prisma_migrations` queda vacía. La causa real (por ejemplo, `check constraint … is
   violated by some row`) está en el log de PostgreSQL (en Neon, en el monitoreo del proyecto), justo
   antes de esa línea. Si no se ve, se reproduce con `psql -v ON_ERROR_STOP=1 -f migration.sql`
   contra una rama de Neon o una copia local, nunca contra la base del entorno: si esta vez no
   falla, su `COMMIT` la aplicaría sin que Prisma la anote. Un `lock_timeout` o un
   `statement_timeout` es transitorio; una CHECK que no valida por filas existentes o un error del
   SQL no lo son.
2. **Confirmar que no quedó nada.** En una migración envuelta basta con comprobar que su primer
   cambio no existe (por ejemplo, que la CHECK o la columna nueva no está). Una migración con
   `CREATE INDEX CONCURRENTLY` no va en una transacción: si falla, deja el índice `INVALID`; se
   borra con `DROP INDEX CONCURRENTLY IF EXISTS <índice>` antes de seguir.
3. **Marcarla como deshecha.**
   `pnpm --filter @anticipate/api db:migrate:resolve --rolled-back <carpeta>` (por ejemplo,
   `20260926152054_stored_files_key_check`). Nunca `--applied`: diría que el cambio está en la base
   cuando la transacción lo deshizo.
4. **Corregir la causa.** Si fue transitoria, no hay nada que cambiar. Si son datos (filas que no
   cumplen una CHECK nueva), se corrigen con un script revisado antes de reintentar. Si es el SQL de
   la migración y esa migración no llegó a aplicarse bien en ningún entorno, se corrige su
   `migration.sql` en un commit; si ya se aplicó en otro entorno, no se edita (paso 6 del flujo): se
   corrige con una migración nueva y la fallida se resuelve como deshecha en el entorno donde falló.
5. **Volver a aplicar.** `pnpm --filter @anticipate/api db:migrate:deploy` (o el despliegue) y
   `db:migrate:status` debe mostrar la base al día.

Nunca se usa `prisma migrate reset` para salir de una migración fallida: borra la base.
