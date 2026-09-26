# Anticipate Factoring

Adelanto de facturas para proveedores de empresas pagadoras. Documento de arquitectura: [docs/STACK.md](docs/STACK.md).

## Requisitos

- Node.js 24 (24.15 o superior): `.node-version` fija la línea 24, `engines.node` acepta `>=24.15 <27` y `devEngines` descarga `^24.15.0` si falta
- pnpm 12.6 o superior instalado de forma nativa
- Docker con Compose v2 (`docker compose`) para la infraestructura local; probado con Docker 29 y Compose 2.40

Si `pnpm build` o `pnpm test` fallan con `Exec format error (os error 8)`, es que pnpm 12 quedó descargado sin su binario nativo (pasa cuando un pnpm 10 global lo descarga con los scripts bloqueados); se arregla instalando pnpm 12 directamente (`npm install -g pnpm@12` o `corepack enable && corepack prepare pnpm@12.6.0 --activate`).

## Comandos

| Comando | Qué hace |
|---|---|
| `pnpm install` | Instala todo el monorepo |
| `pnpm lint` | Biome: linter y formato |
| `pnpm typecheck` | TypeScript en todos los paquetes |
| `pnpm test` | Vitest en todos los paquetes (sin Docker) |
| `pnpm build` | Compila los paquetes |
| `pnpm verify` | Lint, tipos, tests y build de todo el monorepo, en ese orden |
| `pnpm test:watch` | Vitest en modo interactivo sobre todos los paquetes |
| `pnpm --filter @anticipate/shared check:package` | Verifica `exports` y tipos del paquete compilado |
| `pnpm infra:up` | Levanta PostgreSQL, S3Mock y Mailpit y espera a que estén sanos |
| `pnpm infra:down` | Los detiene; los datos quedan en los volúmenes |
| `pnpm infra:reset` | Los detiene y borra los volúmenes; el próximo `infra:up` recrea las tres bases vacías |
| `pnpm infra:logs` | Muestra y sigue los logs de los servicios |
| `pnpm db:generate` | Genera el cliente de Prisma de la API |
| `pnpm db:migrate --name <nombre>` | Crea y aplica una migración en la base de desarrollo |
| `pnpm db:seed` | Carga los datos de ejemplo en la base de desarrollo |
| `pnpm db:check-drift` | Falla si el esquema de Prisma y las migraciones no coinciden |
| `pnpm test:integration` | Tests de integración de la API contra los servicios de Docker |
| `pnpm api:image` | Construye la imagen de la API y la levanta junto a los servicios, en `API_PORT` |

Los comandos `db:*` se delegan en `@anticipate/api` con `--fail-if-no-match`: si el paquete no existe, fallan en vez de no hacer nada (una revisión de deriva que no corre nunca debe pasar en verde).

## Entorno local

La infraestructura corre en Docker Compose (`docker-compose.yml`) y las apps corren en la máquina. Todo se publica solo en `127.0.0.1`, en los puertos que fija el `.env` de la raíz (copia de `.env.example`; Compose lo lee solo).

| Servicio | Imagen | Puerto del host (variable, defecto) | Para qué |
|---|---|---|---|
| PostgreSQL 18 | `postgres:18.6-alpine3.24` | `POSTGRES_PORT`, 5432 | Bases `anticipate` (desarrollo), `anticipate_test` (tests de integración) y `anticipate_shadow` (base sombra de Prisma para `migrate dev` y `db:check-drift`). Usuario y contraseña: `anticipate` |
| S3Mock | `adobe/s3mock:5.2.3` | `S3MOCK_PORT`, 9090 | Reemplaza a Cloudflare R2; bucket `anticipate-local` |
| Mailpit | `axllent/mailpit:v1.31.2` | `MAILPIT_SMTP_PORT`, 1025 (SMTP) y `MAILPIT_UI_PORT`, 8025 (web) | Recibe todos los correos; se leen en `http://localhost:8025` |
| API (perfil `api`) | `anticipate-api:local` | `API_PORT`, 4000 | Solo con `pnpm api:image`: la imagen de producción de la API contra estos servicios |

La primera vez:

```bash
cp .env.example .env
pnpm install
pnpm infra:up
```

- **Puertos ocupados.** Si otro proyecto usa un puerto (por ejemplo, un PostgreSQL propio en el 5432 o una API en el 4000), se cambia en `.env` (`POSTGRES_PORT=5433`, `API_PORT=4001`) y se usa el mismo en `apps/api/.env` y `apps/api/.env.test` (`PORT=4001` y las URLs de la base con `127.0.0.1:5433`). Los `.env` no se versionan; los defectos de `.env.example` son los de CI.
- **Bases.** `docker/postgres/init/01-create-databases.sh` crea `anticipate_test` y `anticipate_shadow` solo cuando el volumen de datos está vacío. Si faltan, o para empezar de cero: `pnpm infra:reset && pnpm infra:up`. Nunca `prisma migrate reset` ni `prisma db push`.
- **Locale.** El cluster se crea con el proveedor builtin de PostgreSQL y `C.UTF-8`, el mismo locale que Neon: el orden de los textos y las mayúsculas y minúsculas no dependen de la libc de la imagen.
- **Correos.** Ningún test envía correo real: los de integración usan el transporte en memoria, salvo el test dedicado a Mailpit.
- **Tests de integración.** `pnpm test:integration` corre con Turborepo en modo estricto de variables: los tests toman su configuración solo de `apps/api/.env.test` y nunca de las variables del shell, así un `DATABASE_URL` exportado no puede apuntarlos a la base de desarrollo.

## API

`apps/api` es la API: NestJS 12 en ESM y Prisma 7.10 sobre PostgreSQL 18, con módulos por capas y todas las respuestas en el sobre de `@anticipate/shared/api`. Su estructura y sus reglas de dependencia están en [`apps/api/PROJECT_STRUCTURE.md`](apps/api/PROJECT_STRUCTURE.md), y las decisiones, en `docs/STACK.md` (D37 a D57).

Para correrla en local, con la infraestructura levantada (`pnpm infra:up`):

1. `cp apps/api/.env.example apps/api/.env` y `cp apps/api/.env.test.example apps/api/.env.test`. Las plantillas traen los puertos por defecto.
2. `pnpm db:migrate` aplica las migraciones en la base `anticipate` y `pnpm db:seed` carga los datos de ejemplo (pagador SEA).
3. `pnpm dev` compila `shared` y `emails`, genera el cliente de Prisma y levanta la API con recarga en caliente.

| Qué | Por defecto | Con el 5432 y el 4000 ocupados |
|---|---|---|
| API con `pnpm dev` (`PORT` en `apps/api/.env`) | `http://localhost:4000` | `http://localhost:4001` |
| Swagger (fuera de producción) | `http://localhost:4000/docs` | `http://localhost:4001/docs` |
| Imagen con `pnpm api:image` (`API_PORT` en `.env`) | `http://localhost:4000` | `http://localhost:4001` |
| PostgreSQL (`POSTGRES_PORT` en `.env` y las URLs de `apps/api/.env` y `apps/api/.env.test`) | `127.0.0.1:5432` | `127.0.0.1:5433` |
| Correos (Mailpit) | `http://localhost:8025` | `http://localhost:8025` |

En la máquina de desarrollo actual, el 5432 y el 4000 los ocupa otro proyecto:
- el `.env` de la raíz fija `POSTGRES_PORT=5433` y `API_PORT=4001`;
- `apps/api/.env` y `apps/api/.env.test` usan `PORT=4001` y `127.0.0.1:5433` en `DATABASE_URL`, `DATABASE_DIRECT_URL` y `SHADOW_DATABASE_URL`.

Los defectos de las plantillas (5432 y 4000) son los de CI.

| Método y ruta | Qué hace |
|---|---|
| `GET /api/v1/payers` | Pagadores activos, con sus campos públicos, para la landing |
| `POST /api/v1/advance-requests` | Recibe una solicitud en multipart: campo `form` con el JSON del formulario, archivos `xml` y `pdf`, y las cabeceras `x-turnstile-token` e `Idempotency-Key`. Si no termina en `SUBMISSION_TIMEOUT_MS` (60 s) responde 503 con `Retry-After` y descarta lo subido (D57). Contrato completo en `docs/STACK.md` (sección 8, D38, D45 y D57) |
| `GET /health` | Liveness: el proceso responde |
| `GET /health/readiness` | Readiness: base, almacenamiento y backlog del outbox. 503 si la base o el almacenamiento no responden; con correos en `DEAD_LETTER` o atrasados responde 200 con `"status": "degraded"`, así que el monitoreo alerta por el cuerpo y no solo por el código (`docs/STACK.md`, sección 12) |

La imagen de producción (`apps/api/Dockerfile`) se arma con `turbo prune` y `pnpm deploy --prod`: sin devDependencies, sin el CLI de Prisma y sin root. Las migraciones nunca corren al arrancar. Se aplican antes con la etapa `migrate` de la misma imagen, que exige la URL directa de la base y se niega a migrar por el pooler de Neon (`apps/api/prisma/cli-guard.ts`; si una migración falla, ver «Si una migración falla» en `docs/database/migrations.md`):

```bash
docker build -f apps/api/Dockerfile --target migrate -t anticipate-api-migrate:local .
docker run --rm --network anticipate_default \
  -e DATABASE_DIRECT_URL=postgresql://anticipate:anticipate@postgres:5432/anticipate \
  anticipate-api-migrate:local
pnpm api:image
```

Con `NODE_ENV=production` la API exige `CORS_ORIGINS`, `TRUST_PROXY` y `TRUST_CLOUDFLARE_HEADERS`: sus valores dependen de Cloudflare y del proxy delante del servidor (tabla «Variables de producción de la API» en `docs/STACK.md`, sección 12). El servicio `api` de Compose trae valores para la imagen local, que no tiene proxy delante.

Al apagarse (`SIGTERM`), la API deja de aceptar conexiones, cierra las ociosas y responde lo que está en curso con `Connection: close`, con un tope de `SHUTDOWN_TIMEOUT_MS` (25 s, D56); si lo pasa, corta lo que queda y sale con código 1 y un log de error. El hosting le da al menos 30 s de gracia antes del SIGKILL: `docker stop` espera solo 10 s si no se configura (`--time 30`; en Compose, `stop_grace_period: 30s`). Tabla completa en `docs/STACK.md`, sección 12, junto con lo que el proxy inverso tiene que esperar a un envío (al menos 90 s: nginx corta a los 60 s si no se configura).

`pnpm api:image` levanta la imagen contra la base `anticipate` de desarrollo: al arrancar, la API corre el publicador del outbox y el mantenimiento (purga, barrido de huérfanos y borrado diferido) sobre esa base y sobre el bucket `anticipate-local`, igual que `pnpm dev`.

## CI

GitHub Actions (`.github/workflows/ci.yml`, permisos de solo lectura) tiene tres jobs:

- `verify`: `pnpm lint` y luego tipos, tests y build con Turborepo. En un pull request corre solo sobre lo afectado (`turbo run typecheck test build --affected`, comparando con `main`) y en `main` sobre todo el monorepo. Al final construye `@anticipate/shared` y corre su `check:package` (publint y attw).
- `integration`: levanta la infraestructura con Docker Compose, la misma definición que en local. Revisa la deriva entre el esquema de Prisma y las migraciones con la base sombra (`pnpm db:check-drift`) y corre los tests de integración de la API, que incluyen las reglas de migración y el test estructural de la base. En un pull request corre solo lo afectado.
- `image`: construye la etapa `migrate` y la imagen de la API. Comprueba que `migrate` se niega a migrar sin `DATABASE_DIRECT_URL`, migra una base vacía, levanta la imagen con el perfil `api` y hace una prueba de humo contra `/health`, `/health/readiness` y `GET /api/v1/payers`. No publica nada.

Un push nuevo a un PR cancela la corrida anterior; en `main` cada commit se verifica completo.

## Estructura

- `packages/shared`: esquemas, reglas de negocio, lector de XML y máquina de estados. Sin código de servidor ni de navegador: su `tsconfig.src.json` compila el código sin tipos de Node ni del DOM (`tsconfig.json` es la del editor y los tests, con modo estricto y tipos de Node) y el test de arquitectura limita qué paquetes importa cada dominio. La fábrica de XML de prueba se publica aparte, en `@anticipate/shared/testing`.
- `packages/config`: presets de TypeScript. La configuración de Biome vive en `biome.json`, en la raíz.
- `apps/api`: la API (NestJS 12 y Prisma 7.10); ver la sección API. La landing y el admin llegan en fases siguientes.
- `docker/`: scripts de inicialización de los servicios locales de `docker-compose.yml`.

## Convenciones

- Código en inglés (identificadores, archivos, modelos); español en mensajes, textos, documentación, comentarios y commits. Glosario en `docs/STACK.md`.
- Las versiones se fijan en el `catalog` de `pnpm-workspace.yaml`; los `package.json` usan `catalog:`. Renovate propone actualizaciones agrupadas los lunes.
  - `prisma`, `@prisma/client` y `@prisma/adapter-pg` van en `7.10.0` exacto. `pg` y `@types/pg` quedan con una sola copia en todo el árbol (`overrides`), porque `@prisma/adapter-pg` reconoce el pool de `pg` con `instanceof`; se comprueba con `pnpm why pg`.
  - `minimumReleaseAge: 1440`: pnpm no resuelve una versión publicada hace menos de un día y falla en vez de saltarse la regla. Un piso del catálogo nunca apunta a una versión de ese mismo día.
  - `allowBuilds` enumera los paquetes que pueden correr scripts de instalación. pnpm 12 falla (`ERR_PNPM_IGNORED_BUILDS`) si aparece uno nuevo sin decidir: se agrega con `true` o `false` después de revisarlo.
- Cada commit pasa por lefthook: Biome sobre lo cambiado y commitlint. Los commits son de una sola línea (Conventional Commits, sin cuerpo ni trailers) y commitlint lo exige con `body-empty` y `footer-empty`.
- Montos con decimal.js y límite `Decimal(14, 2)`.
- Cada app que valide con Zod activa `z.config(z.locales.es())` al arrancar, como respaldo: los esquemas de `shared` ya traen todos sus mensajes en español (lo comprueba `packages/shared/src/spanish-messages.test.ts`) y el locale cubre un esquema propio de la app que olvide el suyo. `shared` nunca llama a `z.config`, que cambia la configuración global del proceso.
- El editor usa Biome como formateador (`.vscode/settings.json`).
- `packages/shared` tiene un test de arquitectura (dirección de dependencias entre dominios y paquetes permitidos por dominio) y una suite dorada. Hoy la suite dorada solo tiene casos semilla generados con la fábrica de prueba (uno de ellos con la forma de un XML real de SUNAT); los XML reales anonimizados se agregan siguiendo `packages/shared/test/golden/README.md`.
