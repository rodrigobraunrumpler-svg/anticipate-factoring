# Base de datos y API mínima · Plan de implementación (paso 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que una solicitud de adelanto entre por la API y termine guardada de punta a punta en la máquina de desarrollo: `POST /advance-requests` con sus XML, validada con las reglas de `@anticipate/shared`, persistida en PostgreSQL con Prisma, con sus archivos en el almacenamiento S3 local y sus dos correos visibles en Mailpit. Más `GET /payers` para la landing y `GET /health` para monitoreo.

**Architecture:** `apps/api` es una app NestJS 12 en ESM. Toda la lógica de negocio pura (lector UBL, reglas, máquina de estados, esquemas) viene de `@anticipate/shared`; la API aporta lo que necesita el mundo real: configuración validada, base de datos, archivos, correo, límites y auditoría. Los módulos siguen la sección 8 del documento de stack con nombres en inglés. La persistencia usa el patrón outbox transaccional (D29): la solicitud y sus notificaciones se escriben en la misma transacción, y un poller las envía fuera de ella con arriendo y reintentos exponenciales. La infraestructura local corre en Docker Compose (PostgreSQL 17, S3Mock, Mailpit); las apps corren en la máquina.

**Tech Stack:** NestJS 12.1 (ESM, Express 5, validación nativa con Standard Schema), Prisma 7.10 fijado sin caret (la etiqueta `latest` de `prisma` ya es la 8 en pruebas) con `@prisma/adapter-pg` y PostgreSQL 17, `@aws-sdk/client-s3` con `WHEN_REQUIRED`, nodemailer 10 hacia Mailpit y Brevo por `fetch` con clave de idempotencia, React Email 6, Cloudflare Turnstile, `@nestjs/schedule` para el outbox, `@nestjs/throttler`, nestjs-pino, `@nestjs/terminus`, Vitest 5 con Vite 8 (sin SWC), Docker Compose. Versiones verificadas contra npm y documentación oficial el 2026-09-24.

**Spec:** `docs/STACK.md` v0.7, secciones 8 (API), 9 (modelo, estados, reglas, convenciones de datos), 10 (archivos, correos, outbox), 11 (controles) y 12 (entorno local, CI). Plan anterior: `docs/superpowers/plans/2026-09-23-fundaciones-y-shared.md` (hecho).

## Global Constraints

- **Idioma**: identificadores, archivos, modelos y columnas en inglés según el glosario de STACK §1; español en mensajes al usuario, comentarios, documentación y commits. Los términos `ruc`, `dni`, `sunat`, `cavali` se quedan.
- **Commits**: una sola línea, Conventional Commits, sin cuerpo ni trailers. Nunca `--no-verify`.
- **Toda la lógica de negocio vive en `@anticipate/shared`**: la API no reimplementa reglas de factura, transiciones ni validación de formularios; las importa. Si falta algo en `shared`, se agrega ahí con su test (este plan agrega siete códigos de problema y `Problem.file`).
- **Versiones fijadas en el `catalog` de `pnpm-workspace.yaml`**; nada a mano en los `package.json`. `prisma`, `@prisma/client` y `@prisma/adapter-pg` van a `7.10.0` exacto, sin caret. `vite` se declara explícito (peer de Vitest 5).
- **Dinero y fechas**: montos como `Amount` (texto) en la API; en Prisma `@db.Decimal(14, 2)` y se escriben como texto; `Decimal` de Prisma se convierte con `normalizeAmount(decimal.toFixed(2))`. Fechas de negocio como `IsoDate`; instantes en `timestamptz` UTC. "Hoy" se calcula una sola vez por petición con `todayIn(LIMA_TIME_ZONE, clock.now())`; el reloj es inyectable.
- **Todo valor de negocio variable viene de la base o de la configuración**: porcentaje de adelanto, plazo mínimo, máximo de facturas y monedas del pagador (tabla `payers`); topes de tamaño, correo del equipo, URL del admin, prefijo del código público, y límites del outbox (variables de entorno validadas con Zod al arrancar; si falta una, la API no arranca).
- **La API nunca devuelve 500 por una entrada del usuario**: los problemas de negocio son `422` con la lista de `Problem` de `shared`; los errores de forma son `400` con los mensajes en español de los esquemas; la infraestructura caída es `503`.
- **Seguridad del único endpoint público** (STACK §11): Turnstile verificado en la API, throttler, tope de bytes del cuerpo antes de leerlo, validación de archivos por contenido, XML con `maxLength`, IP real vía `trust proxy` explícito, CORS con lista blanca, sin datos sensibles en logs.
- **Outbox (D29)**: encolar siempre con el cliente de la transacción del caso de uso; reclamar con una sola sentencia atómica (`FOR UPDATE SKIP LOCKED` + arriendo); enviar fuera de toda transacción; clave de idempotencia de Brevo = id del evento; espera exponencial con tope; `FAILED` al agotar intentos.
- **Bloqueo optimista (D28)**: `updateMany` con `version` y `status` en el `where`; 0 filas → `409`. (Se implementa en el paso 4 con el admin; aquí queda el esquema listo: `version` en `advance_requests`.)
- **Tests**: unitarios junto al código (`src/**/*.test.ts`); de integración en `test/integration/**` contra los contenedores reales, con `migrate deploy` en `anticipate_test`, archivos en serie y `TRUNCATE` entre tests. El poller nunca arranca en tests. Ningún test envía correo real: `MAIL_TRANSPORT=fake` salvo el test dedicado a Mailpit.
- **`apps/api` no exporta nada al monorepo** y solo importa `@anticipate/shared` y `@anticipate/emails` de los paquetes internos.

## Review Focus

1. **Dos envíos simultáneos con la misma factura.** Solo uno debe crear la solicitud; el otro recibe `422` con `INVOICE_ALREADY_IN_OPEN_REQUEST`, y sus archivos ya subidos se borran. Test en la Tarea 9.
2. **La transacción falla después de subir los archivos** (por ejemplo, la base cae). No deben quedar archivos huérfanos en el bucket. Test en la Tarea 9.
3. **Un cuerpo multipart de 200 MB.** Se rechaza por `Content-Length` con `413` antes de leerlo; un XML de 2 MB dentro de un cuerpo pequeño se rechaza con `XML_TOO_LARGE`. Tests en la Tarea 9.
4. **Brevo responde 429 o 500.** El evento vuelve a `PENDING` con espera exponencial y no se envía dos veces; tras 8 intentos queda `FAILED`. Tests en la Tarea 8.
5. **La API se reinicia con eventos en `PROCESSING`.** El arriendo vence y otro poller los retoma; un evento `SENT` nunca se reenvía. Test en la Tarea 8.

---

## Estructura de archivos

```
anticipate-factoring/
├── docker-compose.yml                       PostgreSQL 17, S3Mock, Mailpit; perfil `api` para la imagen
├── docker/postgres/init/01-create-test-db.sh  Crea `anticipate_test` la primera vez
├── .env.example                             Puertos del host para Compose
├── .dockerignore
├── apps/api/
│   ├── package.json · nest-cli.json · tsconfig.json · tsconfig.build.json · vitest.config.ts
│   ├── prisma.config.ts · .env.example · .env.test.example
│   ├── Dockerfile                           Etapas pruner, build, migrate (un solo uso) y runtime sin root
│   ├── prisma/
│   │   ├── schema.prisma                    13 modelos, enums nativos, índice único parcial
│   │   ├── migrations/<ts>_init/migration.sql  SQL generado + secuencia del código público
│   │   └── seed.ts                          Pagador SEA (datos de ejemplo) y usuario admin
│   ├── src/
│   │   ├── main.ts · app.ts (createApp, configureApp) · app.module.ts (AppModule.register)
│   │   ├── generated/prisma/                Cliente generado (ignorado por git)
│   │   ├── config/                          env.schema.ts (Zod), app-config.ts, config.module.ts, clock.ts
│   │   ├── common/                          problems.exception.ts, problems.filter.ts, http-messages.es.ts, client-ip.ts, submit-throttle.ts, body-limit.middleware.ts
│   │   ├── prisma/                          prisma.module.ts, prisma.service.ts, db-values.ts, prisma-errors.ts
│   │   ├── health/                          health.module.ts, health.controller.ts
│   │   ├── storage/                         storage.module.ts, s3-client.factory.ts, storage.service.ts, storage-keys.ts
│   │   ├── payers/                          payers.module.ts, payers.service.ts, payers.controller.ts
│   │   ├── invoices/                        uploaded-files.ts, invoice-reader.ts, validation-context.ts
│   │   ├── notifications/                   outbox.service.ts, outbox-processor.ts, outbox-dispatcher.ts, outbox-poller(.module).ts, retry-delay.ts, mail/ (puerto, smtp, brevo, fake)
│   │   ├── security/                        security.module.ts, turnstile.verifier.ts, turnstile.guard.ts
│   │   └── advance-requests/                advance-requests.module.ts, .controller.ts, .service.ts, advance-request-form.pipe.ts
│   └── test/
│       ├── integration/                     global-setup.ts y *.test.ts contra los contenedores reales
│       └── support/                         config.ts, db.ts, factories.ts, app.ts, mailpit.ts, s3.ts, advance-request-fixtures.ts
├── packages/emails/                         @anticipate/emails: plantillas React Email + render
│   ├── package.json · tsconfig.json · tsdown.config.ts · vitest.config.ts
│   └── src/ index.ts, render.ts, layout.tsx, advance-request-confirmation.tsx, new-advance-request-alert.tsx (+ test)
└── packages/shared/src/errors/              + siete códigos de la API y `Problem.file`
```

**Contrato de `POST /advance-requests`** (multipart/form-data)

| Campo | Tipo | Regla |
|---|---|---|
| `form` | texto JSON | Se valida con `advanceRequestFormSchema` de `shared` (incluye `payerSlug`) |
| `xml` | archivos, 1 a N | XML UBL de cada factura; N ≤ `maxInvoices` del pagador; ≤ 1 MB cada uno (configurable) |
| `pdf` | archivos, 0 a N | Opcional; se empareja con el XML del mismo nombre base (sin extensión, sin distinguir mayúsculas); un PDF sin XML es un problema; ≤ 10 MB cada uno |
| cabecera `x-turnstile-token` | texto | Token de Turnstile; se verifica antes de leer los archivos |

Respuestas: `201 { publicCode }`; `400 { statusCode, error, errors: [{ field, message }] }` errores de forma del campo `form`, o `{ message }` si el multipart está mal armado o trae más archivos de los permitidos; `403` Turnstile rechazado o ausente (`CAPTCHA_FAILED`); `411` envío sin `Content-Length`; `413` cuerpo mayor al máximo; `422 { statusCode, error, problems: Problem[] }` problemas de negocio, todos juntos, cada uno con `file`, `invoice` o `field` según a qué se refiera; `429` límite de envíos por IP; `503` infraestructura caída o Turnstile sin respuesta (`SERVICE_UNAVAILABLE`). Todo texto, en español.

---

### Task 1: Infraestructura local, catálogo y tareas de Turborepo

**Files:**
- Create: `docker-compose.yml`, `docker/postgres/init/01-create-test-db.sh`, `.env.example`, `.dockerignore`
- Modify: `pnpm-workspace.yaml` (catálogo y `allowBuilds`), `package.json` (scripts raíz), `turbo.json`, `.gitignore`, `README.md`

**Interfaces:**
- Produces: los servicios locales (`postgres` en 5432 con las bases `anticipate` y `anticipate_test`, `s3mock` en 9090 con el bucket `anticipate-local`, `mailpit` en 1025 y 8025), los scripts `pnpm infra:up|down|reset|logs`, y las tareas `db:generate`, `test:integration` de turbo que usan las tareas siguientes.

- [ ] **Step 1: Comprobar Docker y el puerto 5432**

Run: `docker --version && docker compose version && (ss -ltn 2>/dev/null | grep -c ':5432 ' || true)`
Expected: Docker 27 o superior con Compose v2. Si el conteo del puerto es mayor que 0, otro PostgreSQL ocupa el 5432 (en esta máquina corre el de `anticipate-health-backend`): en el paso 4 se pone `POSTGRES_PORT=5433` en `.env` y en `apps/api/.env`.

- [ ] **Step 2: Crear `docker-compose.yml`**

```yaml
name: anticipate

services:
  postgres:
    image: postgres:17.11-alpine3.24
    environment:
      POSTGRES_USER: anticipate
      POSTGRES_PASSWORD: anticipate
      POSTGRES_DB: anticipate
    ports:
      - "127.0.0.1:${POSTGRES_PORT:-5432}:5432"
    volumes:
      - postgres-data:/var/lib/postgresql/data
      - ./docker/postgres/init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      # -h 127.0.0.1: la instancia temporal del initdb solo escucha en el socket unix;
      # sin host, pg_isready diría "healthy" antes de que corran los scripts de init.
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U anticipate -d anticipate"]
      interval: 2s
      timeout: 3s
      retries: 20
      start_period: 10s

  s3mock:
    image: adobe/s3mock:5.2.3
    environment:
      COM_ADOBE_TESTING_S3MOCK_STORE_ROOT: /s3mockroot
      COM_ADOBE_TESTING_S3MOCK_STORE_INITIAL_BUCKETS: anticipate-local
      COM_ADOBE_TESTING_S3MOCK_STORE_RETAIN_FILES_ON_EXIT: "true"
      COM_ADOBE_TESTING_S3MOCK_STORE_REGION: us-east-1
    ports:
      - "127.0.0.1:${S3MOCK_PORT:-9090}:9090"
    volumes:
      - s3mock-data:/s3mockroot
    healthcheck:
      test: ["CMD", "wget", "--spider", "-q", "http://localhost:9090/favicon.ico"]
      interval: 2s
      timeout: 3s
      retries: 30
      start_period: 20s

  mailpit:
    image: axllent/mailpit:v1.31.2
    environment:
      MP_SMTP_AUTH_ACCEPT_ANY: "1"
      MP_SMTP_AUTH_ALLOW_INSECURE: "1"
      MP_DATABASE: /data/mailpit.db
      MP_MAX_MESSAGES: "1000"
      TZ: America/Lima
    ports:
      - "127.0.0.1:${MAILPIT_SMTP_PORT:-1025}:1025"
      - "127.0.0.1:${MAILPIT_UI_PORT:-8025}:8025"
    volumes:
      - mailpit-data:/data
    healthcheck:
      test: ["CMD", "/mailpit", "readyz"]
      interval: 2s
      timeout: 3s
      retries: 15

  # Solo con `pnpm api:image`: prueba la imagen real antes de publicarla (Tarea 10).
  api:
    profiles: ["api"]
    build:
      context: .
      dockerfile: apps/api/Dockerfile
      target: runtime
    image: anticipate-api:local
    # Valores de desarrollo, sin secretos (la clave de Turnstile es la de prueba pública de Cloudflare).
    # En línea y no en un env_file: así `infra:up` no depende de un archivo que no todos tienen.
    environment:
      NODE_ENV: production
      PORT: "4000"
      DATABASE_URL: postgresql://anticipate:anticipate@postgres:5432/anticipate
      S3_ENDPOINT: http://s3mock:9090
      S3_REGION: us-east-1
      S3_BUCKET: anticipate-local
      S3_ACCESS_KEY_ID: local
      S3_SECRET_ACCESS_KEY: local
      S3_FORCE_PATH_STYLE: "true"
      MAIL_TRANSPORT: smtp
      SMTP_HOST: mailpit
      SMTP_PORT: "1025"
      MAIL_FROM_EMAIL: solicitudes@anticipate.local
      TEAM_NOTIFICATION_EMAIL: equipo@anticipate.local
      ADMIN_BASE_URL: http://localhost:3000
      TURNSTILE_SECRET_KEY: 1x0000000000000000000000000000000AA
    ports:
      - "127.0.0.1:4000:4000"
    depends_on:
      postgres: { condition: service_healthy }
      s3mock: { condition: service_healthy }
      mailpit: { condition: service_healthy }

volumes:
  postgres-data:
  s3mock-data:
  mailpit-data:
```

`docker/postgres/init/01-create-test-db.sh` (con permiso de ejecución: `chmod +x`):
```bash
#!/bin/bash
# Corre solo la primera vez, con el directorio de datos vacío (`pnpm infra:reset` lo reinicia).
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	CREATE DATABASE anticipate_test OWNER "$POSTGRES_USER";
EOSQL
```

`.env.example` (raíz; Compose lee `.env` para los puertos del host):
```dotenv
POSTGRES_PORT=5432
S3MOCK_PORT=9090
MAILPIT_SMTP_PORT=1025
MAILPIT_UI_PORT=8025
```

`.dockerignore`:
```
node_modules
**/node_modules
**/dist
**/.turbo
**/coverage
**/src/generated
.git
.github
.superpowers
.vscode
docs
**/.env
**/.env.*
!**/.env.example
```

- [ ] **Step 3: Catálogo y scripts de instalación permitidos**

Agregar al `catalog` de `pnpm-workspace.yaml` (obtener las versiones con `cd /tmp && pnpm view <paquete> version`; las de abajo son las verificadas el 2026-09-24):
```yaml
  # NestJS 12 (ESM)
  "@nestjs/common": ^12.1.0
  "@nestjs/core": ^12.1.0
  "@nestjs/platform-express": ^12.1.0
  "@nestjs/testing": ^12.1.0
  "@nestjs/cli": ^12.0.6
  "@nestjs/schematics": ^12.0.5
  "@nestjs/schedule": ^12.0.2
  "@nestjs/throttler": ^6.7.1
  "@nestjs/swagger": ^12.0.2
  "@nestjs/terminus": ^12.1.0
  nestjs-pino: ^5.2.0
  pino: ^10.3.1
  pino-http: ^11.0.0
  pino-pretty: ^13.1.3
  reflect-metadata: ^0.2.2
  rxjs: ^7.8.2
  "@types/express": ^5.0.6
  "@types/multer": ^2.2.0
  # Prisma 7.10 sin caret: `prisma@latest` en npm es 8.0.0-rc
  prisma: 7.10.0
  "@prisma/client": 7.10.0
  "@prisma/adapter-pg": 7.10.0
  pg: ^8.23.0
  "@types/pg": ^8.23.1
  # Archivos, correo, seguridad
  "@aws-sdk/client-s3": ^3.1140.0
  "@aws-sdk/s3-request-presigner": ^3.1140.0
  nodemailer: ^10.0.10
  react-email: ^6.11.0
  react: ^19.3.0
  react-dom: ^19.3.0
  "@types/react": ^19.3.0
  argon2: ^0.45.1
  # Tests
  vite: ^8.3.1
  supertest: ^7.3.0
  "@types/supertest": ^7.2.1
```
(`nodemailer` 10 trae sus tipos; no se instala `@types/nodemailer`. La configuración no usa `@nestjs/config`: se valida con Zod en `createApp` y se inyecta como proveedor, ver Tarea 4.)

Agregar a `allowBuilds`: `prisma: true`, `"@prisma/engines": true`, `argon2: true`. Si `pnpm install` avisa de otro, usar `pnpm approve-builds`.

- [ ] **Step 4: Scripts raíz, turbo y gitignore**

En `package.json` raíz, agregar a `scripts`:
```json
    "infra:up": "docker compose up -d --wait",
    "infra:down": "docker compose down",
    "infra:reset": "docker compose down -v --remove-orphans",
    "infra:logs": "docker compose logs -f",
    "api:image": "docker compose --profile api up -d --build --wait",
    "test:integration": "turbo run test:integration",
    "db:generate": "pnpm --filter @anticipate/api db:generate",
    "db:migrate": "pnpm --filter @anticipate/api db:migrate",
    "db:seed": "pnpm --filter @anticipate/api db:seed",
```

`turbo.json` completo:
```json
{
  "$schema": "https://turbo.build/schema.json",
  "globalEnv": ["CI", "NODE_ENV"],
  "globalDependencies": ["pnpm-workspace.yaml"],
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**", "!.next/cache/**", ".open-next/**"]
    },
    "typecheck": { "dependsOn": ["^build"] },
    "test": { "dependsOn": ["^build"] },
    "db:generate": {
      "inputs": ["prisma/**", "prisma.config.ts"],
      "outputs": ["src/generated/**"]
    },
    "@anticipate/api#build": { "dependsOn": ["^build", "db:generate"], "outputs": ["dist/**"] },
    "@anticipate/api#typecheck": { "dependsOn": ["^build", "db:generate"] },
    "@anticipate/api#test": { "dependsOn": ["^build", "db:generate"] },
    "test:integration": {
      "dependsOn": ["^build", "db:generate"],
      "cache": false,
      "env": ["DATABASE_URL_TEST", "S3_*", "SMTP_*", "MAIL_*", "MAILPIT_API_URL", "TURNSTILE_*", "TEAM_*", "ADMIN_*", "OUTBOX_*", "UPLOAD_*", "THROTTLE_*", "PUBLIC_CODE_PREFIX", "CORS_ORIGINS", "TRUST_*"]
    },
    "dev": { "cache": false, "persistent": true }
  }
}
```

Agregar a `.gitignore`:
```
# cliente de Prisma generado
apps/api/src/generated/
# entorno local (Compose)
.env
```
(Las líneas `.env.*` y `!.env.example` ya existen.)

- [ ] **Step 5: Levantar y verificar**

Run: `cp -n .env.example .env; pnpm install && pnpm infra:up`
Expected: los tres servicios llegan a `healthy` en menos de un minuto. Si el 5432 está ocupado, editar `POSTGRES_PORT=5433` en `.env` y repetir.

Run: `docker compose exec postgres psql -U anticipate -d anticipate -c '\l' | grep -c anticipate_test; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:${S3MOCK_PORT:-9090}/anticipate-local; curl -s http://127.0.0.1:${MAILPIT_UI_PORT:-8025}/readyz`
Expected: `1`, `200`, `ok`.

Run: `pnpm infra:reset && pnpm infra:up`
Expected: vuelve a estado `healthy` y `anticipate_test` existe de nuevo.

- [ ] **Step 6: README**

Agregar al README, en Requisitos: `Docker con Compose v2`. En Comandos: las filas `pnpm infra:up`, `pnpm infra:down`, `pnpm infra:reset`, `pnpm db:migrate`, `pnpm db:seed`, `pnpm test:integration`. En una sección nueva "Entorno local": los tres servicios con sus puertos, dónde ver los correos (`http://localhost:8025`), y la nota del puerto 5432 ocupado.

- [ ] **Step 7: Commit**

```bash
git add docker-compose.yml docker .env.example .dockerignore pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json .gitignore README.md
git commit -m "chore: infraestructura local con docker compose y catálogo del paso 2"
```

---

### Task 2: Códigos de problema de la API en `@anticipate/shared`

**Files:**
- Modify: `packages/shared/src/errors/codes.ts`, `packages/shared/src/errors/messages.es.ts`, `packages/shared/src/errors/problem.ts`
- Test: `packages/shared/src/errors/problem.test.ts`

**Interfaces:**
- Produces: los códigos `PAYER_NOT_AVAILABLE`, `CAPTCHA_FAILED`, `FILE_TOO_LARGE`, `INVALID_PDF`, `PDF_WITHOUT_XML`, `INVOICE_ALREADY_IN_OPEN_REQUEST` y `SERVICE_UNAVAILABLE`, con mensajes en español. La API los usa en las Tareas 7 a 9; así todo texto para personas sigue viviendo en `shared` (R40).
- Produces: `Problem.file?: string` y `ProblemExtra.file?: string`, el nombre del archivo subido al que se refiere el problema. `field` sigue siendo el campo del formulario o de la factura; con `file` la landing marca la fila del archivo exacto, incluso cuando el XML no se pudo leer y no hay serie-número.

- [ ] **Step 1: Escribir el test que falla**

Agregar a `packages/shared/src/errors/problem.test.ts`:
```ts
describe('códigos de la API', () => {
  it('interpolan sus datos en español', () => {
    expect(createProblem('PAYER_NOT_AVAILABLE', { data: { payer: 'sea' } }).message).toBe(
      'El programa de adelanto «sea» no está disponible.',
    )
    expect(createProblem('FILE_TOO_LARGE', { data: { file: 'f1.pdf', max: 10 } }).message).toBe(
      'El archivo f1.pdf supera el máximo de 10 MB.',
    )
    expect(createProblem('INVALID_PDF', { data: { file: 'f1.pdf' } }).message).toBe(
      'El archivo f1.pdf no es un PDF válido.',
    )
    expect(createProblem('PDF_WITHOUT_XML', { data: { file: 'f9.pdf' } }).message).toBe(
      'El PDF f9.pdf no corresponde a ninguna factura XML adjunta.',
    )
    expect(
      createProblem('INVOICE_ALREADY_IN_OPEN_REQUEST', { data: { invoice: 'F001-123' } }).message,
    ).toBe('La factura F001-123 ya está en otra solicitud en curso.')
  })

  it('indica el archivo al que se refiere, sin confundirlo con el campo', () => {
    const p = createProblem('XML_MISSING_REQUIRED_FIELD', {
      file: 'F001-1.xml',
      field: 'issuerRuc',
      data: { field: 'RUC del emisor' },
    })
    expect(p).toMatchObject({ file: 'F001-1.xml', field: 'issuerRuc' })
    expect(createProblem('NO_INVOICES')).not.toHaveProperty('file')
  })

  it('los mensajes sin datos son frases completas', () => {
    expect(createProblem('CAPTCHA_FAILED').message).toBe(
      'No pudimos verificar que eres una persona. Recarga la página e inténtalo de nuevo.',
    )
    expect(createProblem('SERVICE_UNAVAILABLE').message).toBe(
      'No pudimos procesar tu solicitud en este momento. Inténtalo de nuevo en unos minutos.',
    )
  })
})
```

Run: `pnpm --filter @anticipate/shared exec vitest run src/errors`
Expected: FAIL; TypeScript o Vitest informan que los códigos y la propiedad `file` no existen.

- [ ] **Step 2: Agregar los códigos, sus mensajes y `file`**

En `packages/shared/src/errors/problem.ts`, a `Problem` (después de `field`):
```ts
  /** Nombre del archivo subido al que se refiere (XML o PDF), si aplica. */
  file?: string
```
a `ProblemExtra` (después de `field`):
```ts
  file?: string
```
y en `createProblem`, después de la línea de `field`:
```ts
  if (extra.file !== undefined) problem.file = extra.file
```

Al final de `PROBLEM_CODES` en `packages/shared/src/errors/codes.ts`, después de `'CLOSE_REASON_DETAIL_REQUIRED',`:
```ts
  // API: recepción de solicitudes
  'PAYER_NOT_AVAILABLE',
  'CAPTCHA_FAILED',
  'FILE_TOO_LARGE',
  'INVALID_PDF',
  'PDF_WITHOUT_XML',
  'INVOICE_ALREADY_IN_OPEN_REQUEST',
  'SERVICE_UNAVAILABLE',
```

Al final de `MESSAGES_ES` en `packages/shared/src/errors/messages.es.ts`:
```ts
  PAYER_NOT_AVAILABLE: 'El programa de adelanto «{payer}» no está disponible.',
  CAPTCHA_FAILED:
    'No pudimos verificar que eres una persona. Recarga la página e inténtalo de nuevo.',
  FILE_TOO_LARGE: 'El archivo {file} supera el máximo de {max} MB.',
  INVALID_PDF: 'El archivo {file} no es un PDF válido.',
  PDF_WITHOUT_XML: 'El PDF {file} no corresponde a ninguna factura XML adjunta.',
  INVOICE_ALREADY_IN_OPEN_REQUEST: 'La factura {invoice} ya está en otra solicitud en curso.',
  SERVICE_UNAVAILABLE:
    'No pudimos procesar tu solicitud en este momento. Inténtalo de nuevo en unos minutos.',
```

- [ ] **Step 3: Verificar**

Run: `pnpm --filter @anticipate/shared exec vitest run src/errors && pnpm --filter @anticipate/shared test && pnpm typecheck && pnpm lint:fix && pnpm lint`
Expected: todo en verde; el test existente "todo código tiene mensaje" y la guardia de mensajes en español siguen pasando.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/errors
git commit -m "feat(shared): códigos de problema y archivo de origen para la recepción de solicitudes"
```

---

### Task 3: Paquete `@anticipate/emails` con las dos plantillas

**Files:**
- Create: `packages/emails/package.json`, `packages/emails/tsconfig.json`, `packages/emails/tsdown.config.ts`, `packages/emails/vitest.config.ts`
- Create: `packages/emails/src/index.ts`, `packages/emails/src/layout.tsx`, `packages/emails/src/advance-request-confirmation.tsx`, `packages/emails/src/new-advance-request-alert.tsx`, `packages/emails/src/render.ts`
- Test: `packages/emails/src/render.test.ts`
- Modify: `packages/shared/src/architecture.test.ts` no se toca (es de `shared`); `tsconfig` y `turbo` ya cubren el paquete nuevo.

**Interfaces:**
- Consumes: nada del monorepo.
- Produces: `renderAdvanceRequestConfirmation(data): Promise<RenderedEmail>` y `renderNewAdvanceRequestAlert(data): Promise<RenderedEmail>`, con `RenderedEmail = { subject: string; html: string; text: string }`, `AdvanceRequestConfirmationData = { contactName: string; publicCode: string; payerName: string; requestedAmount: string; currency: string; invoiceCount: number }` y `NewAdvanceRequestAlertData = { publicCode: string; payerName: string; supplierName: string; supplierRuc: string; requestedAmount: string; currency: string; invoiceCount: number; adminUrl: string }`. El dispatcher del outbox (Tarea 8) los usa.

- [ ] **Step 1: Crear el paquete**

`packages/emails/package.json`:
```json
{
  "name": "@anticipate/emails",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "sideEffects": false,
  "files": ["dist"],
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
  },
  "scripts": {
    "build": "tsdown",
    "dev": "tsdown --watch",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "catalog:",
    "react-dom": "catalog:",
    "react-email": "catalog:"
  },
  "devDependencies": {
    "@anticipate/config": "workspace:*",
    "@types/node": "catalog:",
    "@types/react": "catalog:",
    "tsdown": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```

`packages/emails/tsconfig.json`:
```json
{
  "extends": "@anticipate/config/tsconfig.library.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM"],
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "*.config.ts"]
}
```
Si `rootDir` del preset choca con los `*.config.ts` (TS6059), quitar `*.config.ts` de `include`: tsdown y Vitest los validan al cargarlos.

`packages/emails/tsdown.config.ts`:
```ts
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  dts: true,
  sourcemap: true,
  clean: true,
})
```

`packages/emails/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { name: 'emails', environment: 'node', include: ['src/**/*.test.ts'] },
})
```

Run: `pnpm install`
Expected: el paquete aparece en el workspace; `react-email` 6 y React 19 instalados.

- [ ] **Step 2: Escribir el test que falla**

`packages/emails/src/render.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { renderAdvanceRequestConfirmation, renderNewAdvanceRequestAlert } from './render.js'

describe('renderAdvanceRequestConfirmation', () => {
  it('saluda al contacto y muestra el código, el pagador y el monto', async () => {
    const email = await renderAdvanceRequestConfirmation({
      contactName: 'Ana Pérez',
      publicCode: 'ANT-2026-000123',
      payerName: 'SEA',
      requestedAmount: '8000.00',
      currency: 'PEN',
      invoiceCount: 2,
    })
    expect(email.subject).toBe('Recibimos tu solicitud ANT-2026-000123')
    expect(email.html).toContain('<html lang="es"')
    expect(email.html).toContain('Ana Pérez')
    expect(email.html).toContain('ANT-2026-000123')
    expect(email.text).toContain('PEN 8000.00')
    expect(email.text).toContain('2 facturas')
  })

  it('escapa el texto controlado por el usuario', async () => {
    const email = await renderAdvanceRequestConfirmation({
      contactName: '<script>alert(1)</script>',
      publicCode: 'ANT-2026-000001',
      payerName: 'SEA',
      requestedAmount: '1.00',
      currency: 'USD',
      invoiceCount: 1,
    })
    expect(email.html).not.toContain('<script>')
    expect(email.text).toContain('1 factura')
    expect(email.text).not.toContain('1 facturas')
  })
})

describe('renderNewAdvanceRequestAlert', () => {
  it('incluye el enlace al detalle en el admin', async () => {
    const email = await renderNewAdvanceRequestAlert({
      publicCode: 'ANT-2026-000123',
      payerName: 'SEA',
      supplierName: 'PROVEEDOR EJEMPLO S.A.C.',
      supplierRuc: '20100070970',
      requestedAmount: '8000.00',
      currency: 'PEN',
      invoiceCount: 2,
      adminUrl: 'http://localhost:3000/advance-requests/0b4e6c2d',
    })
    expect(email.subject).toBe('Nueva solicitud ANT-2026-000123 · SEA')
    expect(email.html).toContain('href="http://localhost:3000/advance-requests/0b4e6c2d"')
    expect(email.text).toContain('20100070970')
  })
})
```

Run: `pnpm --filter @anticipate/emails exec vitest run`
Expected: FAIL, `Cannot find module './render.js'`.

- [ ] **Step 3: Implementar las plantillas**

`packages/emails/src/layout.tsx`:
```tsx
import { Body, Container, Head, Html, Preview, Section, Text } from 'react-email'
import type { ReactNode } from 'react'

/** Marco común de los correos: idioma, vista previa y pie. */
export function Layout(props: { preview: string; children: ReactNode }) {
  return (
    <Html lang="es">
      <Head />
      <Preview>{props.preview}</Preview>
      <Body style={{ backgroundColor: '#f6f7f9', fontFamily: 'Arial, Helvetica, sans-serif' }}>
        <Container style={{ backgroundColor: '#ffffff', padding: '24px', maxWidth: '560px' }}>
          {props.children}
          <Section>
            <Text style={{ color: '#6b7280', fontSize: '12px' }}>
              Anticipate · Este es un correo automático, no respondas a esta dirección.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}
```

`packages/emails/src/advance-request-confirmation.tsx`:
```tsx
import { Heading, Text } from 'react-email'
import { Layout } from './layout.js'

export type AdvanceRequestConfirmationData = {
  contactName: string
  publicCode: string
  payerName: string
  requestedAmount: string
  currency: string
  invoiceCount: number
}

export const invoicesLabel = (count: number) => `${count} ${count === 1 ? 'factura' : 'facturas'}`

export function AdvanceRequestConfirmation(props: AdvanceRequestConfirmationData) {
  return (
    <Layout preview={`Recibimos tu solicitud ${props.publicCode}`}>
      <Heading as="h1">Recibimos tu solicitud</Heading>
      <Text>Hola, {props.contactName}:</Text>
      <Text>
        Registramos tu solicitud de adelanto <strong>{props.publicCode}</strong> para las facturas
        emitidas a {props.payerName}.
      </Text>
      <Text>
        Monto solicitado: {props.currency} {props.requestedAmount} · {invoicesLabel(props.invoiceCount)}
      </Text>
      <Text>
        Próximo paso: nuestro equipo te llamará para revisar la solicitud y pedirte los documentos
        del representante legal (DNI y vigencia de poder).
      </Text>
    </Layout>
  )
}
```

`packages/emails/src/new-advance-request-alert.tsx`:
```tsx
import { Button, Heading, Text } from 'react-email'
import { invoicesLabel } from './advance-request-confirmation.js'
import { Layout } from './layout.js'

export type NewAdvanceRequestAlertData = {
  publicCode: string
  payerName: string
  supplierName: string
  supplierRuc: string
  requestedAmount: string
  currency: string
  invoiceCount: number
  adminUrl: string
}

export function NewAdvanceRequestAlert(props: NewAdvanceRequestAlertData) {
  return (
    <Layout preview={`Nueva solicitud ${props.publicCode} de ${props.supplierName}`}>
      <Heading as="h1">Nueva solicitud {props.publicCode}</Heading>
      <Text>
        {props.supplierName} (RUC {props.supplierRuc}) pide un adelanto sobre facturas a{' '}
        {props.payerName}.
      </Text>
      <Text>
        Monto solicitado: {props.currency} {props.requestedAmount} · {invoicesLabel(props.invoiceCount)}
      </Text>
      <Button href={props.adminUrl}>Ver en el admin</Button>
    </Layout>
  )
}
```

`packages/emails/src/render.ts`:
```ts
import { createElement } from 'react'
import { render } from 'react-email'
import {
  AdvanceRequestConfirmation,
  type AdvanceRequestConfirmationData,
} from './advance-request-confirmation.js'
import { NewAdvanceRequestAlert, type NewAdvanceRequestAlertData } from './new-advance-request-alert.js'

export type RenderedEmail = { subject: string; html: string; text: string }

async function renderBoth(element: ReturnType<typeof createElement>) {
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })])
  return { html, text }
}

export async function renderAdvanceRequestConfirmation(
  data: AdvanceRequestConfirmationData,
): Promise<RenderedEmail> {
  const { html, text } = await renderBoth(createElement(AdvanceRequestConfirmation, data))
  return { subject: `Recibimos tu solicitud ${data.publicCode}`, html, text }
}

export async function renderNewAdvanceRequestAlert(
  data: NewAdvanceRequestAlertData,
): Promise<RenderedEmail> {
  const { html, text } = await renderBoth(createElement(NewAdvanceRequestAlert, data))
  return { subject: `Nueva solicitud ${data.publicCode} · ${data.payerName}`, html, text }
}
```

`packages/emails/src/index.ts`:
```ts
export type { AdvanceRequestConfirmationData } from './advance-request-confirmation.js'
export type { NewAdvanceRequestAlertData } from './new-advance-request-alert.js'
export {
  type RenderedEmail,
  renderAdvanceRequestConfirmation,
  renderNewAdvanceRequestAlert,
} from './render.js'
```

- [ ] **Step 4: Verificar**

Run: `pnpm --filter @anticipate/emails exec vitest run && pnpm --filter @anticipate/emails typecheck && pnpm --filter @anticipate/emails build && pnpm lint:fix && pnpm lint`
Expected: 3 tests PASS; `dist/index.js` y `dist/index.d.ts` generados. Si el texto plano de React Email separa `PEN 8000.00` en líneas distintas, ajustar la plantilla (no el test) para que el monto quede en una sola línea.

- [ ] **Step 5: Commit**

```bash
git add packages/emails pnpm-lock.yaml
git commit -m "feat(emails): plantillas de confirmación al proveedor y aviso al equipo"
```

---

### Task 4: Esqueleto de `apps/api`: configuración, errores, límites, logs y salud

**Files:**
- Create: `apps/api/package.json`, `apps/api/nest-cli.json`, `apps/api/tsconfig.json`, `apps/api/tsconfig.build.json`, `apps/api/vitest.config.ts`, `apps/api/.env.example`, `apps/api/.env.test.example`
- Create: `apps/api/src/main.ts`, `apps/api/src/app.ts`, `apps/api/src/app.module.ts`
- Create: `apps/api/src/config/env.schema.ts`, `apps/api/src/config/app-config.ts`, `apps/api/src/config/config.module.ts`, `apps/api/src/config/clock.ts`
- Create: `apps/api/src/common/http-messages.es.ts`, `apps/api/src/common/problems.exception.ts`, `apps/api/src/common/problems.filter.ts`, `apps/api/src/common/client-ip.ts`, `apps/api/src/common/submit-throttle.ts`
- Create: `apps/api/src/health/health.module.ts`, `apps/api/src/health/health.controller.ts`
- Create: `apps/api/test/support/config.ts`
- Test: `apps/api/src/config/env.schema.test.ts`, `apps/api/src/app.test.ts`

**Interfaces:**
- Consumes: `Problem` de `@anticipate/shared/errors`.
- Produces:
  - `parseConfig(env: Record<string, string | undefined>): AppConfig` y el tipo `AppConfig` (anidado: `nodeEnv`, `port`, `logLevel`, `databaseUrl`, `corsOrigins`, `trustProxy`, `trustCloudflareHeaders`, `storage`, `mail`, `turnstile`, `upload`, `publicCodePrefix`, `throttle`, `outbox`, `adminBaseUrl`, `teamNotificationEmail`).
  - Tokens `APP_CONFIG` y `CLOCK`, tipo `Clock = { now(): Date }`, `systemClock`.
  - `AppModule.register(config, extraModules?)` y `createApp(config, options?)`: las tareas siguientes agregan sus módulos a `AppModule.register`.
  - `ProblemsException(problems, status = 422)`, `ProblemsFilter`, `resolveClientIp(req, trustCloudflareHeaders)`, el decorador `@SubmitThrottle()`.
  - `testEnv(overrides)` y `testConfig(overrides)` para tests.

**Decisiones de este esqueleto.** La configuración no usa `@nestjs/config`: `createApp` recibe un `AppConfig` ya validado con Zod y `AppModule.register(config)` la provee como `APP_CONFIG`. Así cada test arma su configuración sin tocar `process.env`, y el poller del outbox (Tarea 8) se registra solo si la configuración lo pide. Los mensajes HTTP genéricos en español viven en `src/common/http-messages.es.ts`; los problemas de negocio vienen de `shared`.

- [ ] **Step 1: Crear el paquete de la API**

`apps/api/package.json`:
```json
{
  "name": "@anticipate/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "nest build",
    "dev": "nest start --watch",
    "start": "node dist/main.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --project api:unit",
    "test:integration": "vitest run --project api:integration",
    "db:generate": "prisma generate",
    "db:migrate": "prisma migrate dev",
    "db:migrate:create": "prisma migrate dev --create-only",
    "db:deploy": "prisma migrate deploy",
    "db:seed": "prisma db seed"
  },
  "dependencies": {
    "@anticipate/emails": "workspace:*",
    "@anticipate/shared": "workspace:*",
    "@nestjs/common": "catalog:",
    "@nestjs/core": "catalog:",
    "@nestjs/platform-express": "catalog:",
    "@nestjs/schedule": "catalog:",
    "@nestjs/swagger": "catalog:",
    "@nestjs/terminus": "catalog:",
    "@nestjs/throttler": "catalog:",
    "nestjs-pino": "catalog:",
    "pino": "catalog:",
    "pino-http": "catalog:",
    "reflect-metadata": "catalog:",
    "rxjs": "catalog:",
    "zod": "catalog:"
  },
  "devDependencies": {
    "@anticipate/config": "workspace:*",
    "@nestjs/cli": "catalog:",
    "@nestjs/schematics": "catalog:",
    "@nestjs/testing": "catalog:",
    "@types/express": "catalog:",
    "@types/multer": "catalog:",
    "@types/node": "catalog:",
    "@types/supertest": "catalog:",
    "pino-pretty": "catalog:",
    "supertest": "catalog:",
    "typescript": "catalog:",
    "vite": "catalog:",
    "vitest": "catalog:"
  }
}
```
Las dependencias de Prisma, S3, correo y argon2 se agregan en las tareas que las usan.

`apps/api/nest-cli.json`:
```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": { "deleteOutDir": true, "tsConfigPath": "tsconfig.build.json" }
}
```

`apps/api/tsconfig.json` (extiende el preset de Node del monorepo: NodeNext, decoradores con metadatos, sin `verbatimModuleSyntax` porque rompería los metadatos de inyección):
```json
{
  "extends": "@anticipate/config/tsconfig.node.json",
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "strictPropertyInitialization": false,
    "sourceMap": true,
    "outDir": "./dist",
    "types": ["node", "multer"],
    "noEmit": true
  },
  "include": ["src", "test", "prisma", "prisma.config.ts", "vitest.config.ts"]
}
```

`apps/api/tsconfig.build.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false, "rootDir": "./src" },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

`apps/api/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'api:unit',
          include: ['src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'api:integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['./test/integration/global-setup.ts'],
          // Una sola base anticipate_test: los archivos corren en serie y se trunca entre tests.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
})
```
(El `global-setup.ts` de integración se crea en la Tarea 5; hasta entonces el proyecto de integración no tiene archivos.)

Run: `pnpm install`
Expected: instala NestJS 12 y Vitest; no hay avisos de peer faltante (Vite 8 está declarado).

- [ ] **Step 2: Escribir los tests de configuración que fallan**

`apps/api/test/support/config.ts`:
```ts
import { type AppConfig, parseConfig } from '../../src/config/app-config.js'

/** Variables de un entorno de prueba completo, apuntando a los contenedores locales. */
export function testEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL:
      process.env.DATABASE_URL_TEST ??
      'postgresql://anticipate:anticipate@127.0.0.1:5432/anticipate_test',
    S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9090',
    S3_REGION: 'us-east-1',
    S3_BUCKET: process.env.S3_BUCKET ?? 'anticipate-local',
    S3_ACCESS_KEY_ID: 'local',
    S3_SECRET_ACCESS_KEY: 'local',
    MAIL_TRANSPORT: 'fake',
    MAIL_FROM_EMAIL: 'solicitudes@anticipate.local',
    TEAM_NOTIFICATION_EMAIL: 'equipo@anticipate.local',
    ADMIN_BASE_URL: 'http://localhost:3000',
    TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
    OUTBOX_POLLER_ENABLED: 'false',
    ...overrides,
  }
}

export function testConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  return parseConfig(testEnv(overrides))
}
```

`apps/api/src/config/env.schema.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { testEnv } from '../../test/support/config.js'
import { parseConfig } from './app-config.js'

describe('parseConfig', () => {
  it('aplica los valores por defecto', () => {
    const c = parseConfig(testEnv())
    expect(c.port).toBe(4000)
    expect(c.upload).toEqual({
      maxBodyBytes: 95_000_000,
      maxPdfBytes: 10 * 1024 * 1024,
      maxXmlBytes: 1024 * 1024,
      maxFiles: 20,
    })
    expect(c.publicCodePrefix).toBe('ANT')
    expect(c.corsOrigins).toEqual(['http://localhost:4321', 'http://localhost:3000'])
    expect(c.trustProxy).toBe('loopback')
    expect(c.outbox.pollerEnabled).toBe(false)
    expect(c.storage.forcePathStyle).toBe(true)
  })

  it('trata las variables vacías como ausentes', () => {
    expect(() => parseConfig(testEnv({ S3_BUCKET: '   ' }))).toThrow(/S3_BUCKET: es obligatoria/)
  })

  it('explica en español cada variable inválida', () => {
    const run = () =>
      parseConfig(testEnv({ DATABASE_URL: 'mysql://x', PORT: 'abc', MAIL_TRANSPORT: 'sendgrid' }))
    expect(run).toThrow(/Configuración inválida/)
    expect(run).toThrow(/DATABASE_URL: debe empezar con postgresql:\/\//)
    expect(run).toThrow(/PORT: debe ser un número/)
    expect(run).toThrow(/MAIL_TRANSPORT: debe ser smtp, brevo o fake/)
  })

  it('exige SMTP_HOST con smtp y BREVO_API_KEY con brevo', () => {
    expect(() => parseConfig(testEnv({ MAIL_TRANSPORT: 'smtp' }))).toThrow(/SMTP_HOST: es obligatoria con MAIL_TRANSPORT=smtp/)
    expect(() => parseConfig(testEnv({ MAIL_TRANSPORT: 'brevo' }))).toThrow(/BREVO_API_KEY: es obligatoria con MAIL_TRANSPORT=brevo/)
    expect(parseConfig(testEnv({ MAIL_TRANSPORT: 'smtp', SMTP_HOST: '127.0.0.1' })).mail).toMatchObject({
      transport: 'smtp',
      smtpHost: '127.0.0.1',
      smtpPort: 1025,
    })
  })

  it('convierte TRUST_PROXY a lo que entiende Express, sin permitir confiar en todo', () => {
    expect(parseConfig(testEnv({ TRUST_PROXY: 'false' })).trustProxy).toBe(false)
    expect(parseConfig(testEnv({ TRUST_PROXY: '1' })).trustProxy).toBe(1)
    expect(parseConfig(testEnv({ TRUST_PROXY: '10.0.0.0/8, loopback' })).trustProxy).toBe('10.0.0.0/8, loopback')
    expect(() => parseConfig(testEnv({ TRUST_PROXY: 'true' }))).toThrow(/TRUST_PROXY: no puede ser true/)
  })
})
```

Run: `pnpm --filter @anticipate/api exec vitest run --project api:unit src/config`
Expected: FAIL, `Cannot find module './app-config.js'`.

- [ ] **Step 3: Implementar la configuración y el reloj**

`apps/api/src/config/env.schema.ts`:
```ts
import { z } from 'zod'

const required = z.string({ error: 'es obligatoria' }).trim().min(1, { error: 'es obligatoria' })
const flag = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'], { error: 'debe ser true o false' })
    .default(fallback)
    .transform((v) => v === 'true')
const integer = (fallback: number, min = 1) =>
  z.coerce
    .number({ error: 'debe ser un número' })
    .int({ error: 'debe ser un entero' })
    .min(min, { error: `debe ser al menos ${min}` })
    .default(fallback)
const httpUrl = z.url({ error: 'debe ser una URL', protocol: /^https?$/ })

/** Variables de entorno de la API. Los valores de negocio del pagador viven en la base, no aquí. */
export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'], { error: 'debe ser development, test o production' })
      .default('development'),
    PORT: integer(4000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'], {
        error: 'debe ser un nivel de pino (fatal, error, warn, info, debug, trace o silent)',
      })
      .default('info'),
    DATABASE_URL: required.regex(/^postgres(ql)?:\/\//, { error: 'debe empezar con postgresql://' }),
    CORS_ORIGINS: z.string().default('http://localhost:4321,http://localhost:3000'),
    TRUST_PROXY: z
      .string()
      .default('loopback')
      .refine((v) => v.trim().toLowerCase() !== 'true', {
        error: 'no puede ser true: indica los saltos o las subredes de tu proxy',
      }),
    TRUST_CLOUDFLARE_HEADERS: flag('false'),
    S3_ENDPOINT: httpUrl.optional(),
    S3_REGION: required.default('auto'),
    S3_BUCKET: required,
    S3_ACCESS_KEY_ID: required,
    S3_SECRET_ACCESS_KEY: required,
    S3_FORCE_PATH_STYLE: flag('true'),
    MAIL_TRANSPORT: z.enum(['smtp', 'brevo', 'fake'], { error: 'debe ser smtp, brevo o fake' }),
    SMTP_HOST: required.optional(),
    SMTP_PORT: integer(1025),
    BREVO_API_KEY: required.optional(),
    MAIL_FROM_EMAIL: z.email({ error: 'debe ser un correo' }),
    MAIL_FROM_NAME: required.default('Anticipate'),
    TEAM_NOTIFICATION_EMAIL: z.email({ error: 'debe ser un correo' }),
    ADMIN_BASE_URL: httpUrl,
    TURNSTILE_SECRET_KEY: required,
    TURNSTILE_EXPECTED_HOSTNAME: required.optional(),
    UPLOAD_MAX_BODY_BYTES: integer(95_000_000),
    UPLOAD_MAX_PDF_BYTES: integer(10 * 1024 * 1024),
    UPLOAD_MAX_XML_BYTES: integer(1024 * 1024),
    UPLOAD_MAX_FILES: integer(20),
    PUBLIC_CODE_PREFIX: required.regex(/^[A-Z]{2,6}$/, { error: 'debe tener de 2 a 6 letras mayúsculas' }).default('ANT'),
    THROTTLE_DEFAULT_LIMIT: integer(120),
    THROTTLE_DEFAULT_TTL_SECONDS: integer(60),
    THROTTLE_SUBMIT_LIMIT: integer(5),
    THROTTLE_SUBMIT_TTL_SECONDS: integer(3600),
    OUTBOX_POLLER_ENABLED: flag('true'),
    OUTBOX_POLL_INTERVAL_MS: integer(5000, 100),
    OUTBOX_BATCH_SIZE: integer(20),
    OUTBOX_LEASE_SECONDS: integer(120),
    OUTBOX_BASE_DELAY_MS: integer(30_000),
    OUTBOX_MAX_DELAY_MS: integer(3_600_000),
    OUTBOX_MAX_ATTEMPTS: integer(8),
  })
  .superRefine((env, ctx) => {
    if (env.MAIL_TRANSPORT === 'smtp' && !env.SMTP_HOST) {
      ctx.addIssue({ code: 'custom', path: ['SMTP_HOST'], message: 'es obligatoria con MAIL_TRANSPORT=smtp' })
    }
    if (env.MAIL_TRANSPORT === 'brevo' && !env.BREVO_API_KEY) {
      ctx.addIssue({ code: 'custom', path: ['BREVO_API_KEY'], message: 'es obligatoria con MAIL_TRANSPORT=brevo' })
    }
  })

export type Env = z.output<typeof envSchema>
```

`apps/api/src/config/app-config.ts`:
```ts
import { type Env, envSchema } from './env.schema.js'

function trustProxyValue(raw: string): string | number | boolean {
  const value = raw.trim()
  if (value.toLowerCase() === 'false') return false
  if (/^\d+$/.test(value)) return Number(value)
  return value
}

function toAppConfig(env: Env) {
  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    corsOrigins: env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
    trustProxy: trustProxyValue(env.TRUST_PROXY),
    trustCloudflareHeaders: env.TRUST_CLOUDFLARE_HEADERS,
    storage: {
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
    },
    mail: {
      transport: env.MAIL_TRANSPORT,
      smtpHost: env.SMTP_HOST,
      smtpPort: env.SMTP_PORT,
      brevoApiKey: env.BREVO_API_KEY,
      fromEmail: env.MAIL_FROM_EMAIL,
      fromName: env.MAIL_FROM_NAME,
    },
    turnstile: { secretKey: env.TURNSTILE_SECRET_KEY, expectedHostname: env.TURNSTILE_EXPECTED_HOSTNAME },
    upload: {
      maxBodyBytes: env.UPLOAD_MAX_BODY_BYTES,
      maxPdfBytes: env.UPLOAD_MAX_PDF_BYTES,
      maxXmlBytes: env.UPLOAD_MAX_XML_BYTES,
      maxFiles: env.UPLOAD_MAX_FILES,
    },
    publicCodePrefix: env.PUBLIC_CODE_PREFIX,
    throttle: {
      defaultLimit: env.THROTTLE_DEFAULT_LIMIT,
      defaultTtlMs: env.THROTTLE_DEFAULT_TTL_SECONDS * 1000,
      submitLimit: env.THROTTLE_SUBMIT_LIMIT,
      submitTtlMs: env.THROTTLE_SUBMIT_TTL_SECONDS * 1000,
    },
    outbox: {
      pollerEnabled: env.OUTBOX_POLLER_ENABLED,
      pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
      batchSize: env.OUTBOX_BATCH_SIZE,
      leaseSeconds: env.OUTBOX_LEASE_SECONDS,
      baseDelayMs: env.OUTBOX_BASE_DELAY_MS,
      maxDelayMs: env.OUTBOX_MAX_DELAY_MS,
      maxAttempts: env.OUTBOX_MAX_ATTEMPTS,
    },
    adminBaseUrl: env.ADMIN_BASE_URL.replace(/\/+$/, ''),
    teamNotificationEmail: env.TEAM_NOTIFICATION_EMAIL,
  }
}

export type AppConfig = ReturnType<typeof toAppConfig>

/** Valida el entorno; si algo falta o es inválido, la API no arranca y dice qué corregir. */
export function parseConfig(raw: Record<string, string | undefined>): AppConfig {
  const present = Object.fromEntries(
    Object.entries(raw).filter(([, v]) => v !== undefined && v.trim() !== ''),
  )
  const result = envSchema.safeParse(present)
  if (!result.success) {
    const lines = result.error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`)
    throw new Error(`Configuración inválida:\n${lines.join('\n')}`)
  }
  return toAppConfig(result.data)
}
```

`apps/api/src/config/clock.ts`:
```ts
export type Clock = { now(): Date }
export const CLOCK = Symbol('CLOCK')
export const systemClock: Clock = { now: () => new Date() }
```

`apps/api/src/config/config.module.ts`:
```ts
import { type DynamicModule, Global, Module } from '@nestjs/common'
import type { AppConfig } from './app-config.js'
import { CLOCK, systemClock } from './clock.js'

export const APP_CONFIG = Symbol('APP_CONFIG')

@Global()
@Module({})
export class AppConfigModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppConfigModule,
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: CLOCK, useValue: systemClock },
      ],
      exports: [APP_CONFIG, CLOCK],
    }
  }
}
```

Run: `pnpm --filter @anticipate/api exec vitest run --project api:unit src/config`
Expected: 5 tests PASS. Si Zod 4 no acepta `protocol` en `z.url`, usar `z.httpUrl({ error })` (existe en la versión instalada).

- [ ] **Step 4: Escribir los tests de la app que fallan**

`apps/api/src/app.test.ts`:
```ts
import { Controller, Get, Module, Post } from '@nestjs/common'
import { createProblem } from '@anticipate/shared/errors'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testConfig } from '../test/support/config.js'
import { createApp } from './app.js'
import { ProblemsException } from './common/problems.exception.js'

@Controller('__test')
class ProbeController {
  @Get('problems')
  problems() {
    throw new ProblemsException([createProblem('NO_INVOICES')])
  }

  @Get('boom')
  boom() {
    throw new Error('detalle interno que no debe salir')
  }

  @Post('json')
  json() {
    return { ok: true }
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

describe('createApp', () => {
  let app: Awaited<ReturnType<typeof createApp>>

  beforeAll(async () => {
    app = await createApp(testConfig(), { extraModules: [ProbeModule] })
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  it('GET /health responde ok', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200)
    expect(res.body.status).toBe('ok')
  })

  it('devuelve el id de petición recibido o uno nuevo', async () => {
    const res = await request(app.getHttpServer()).get('/health').set('x-request-id', 'abc-123')
    expect(res.headers['x-request-id']).toBe('abc-123')
    const res2 = await request(app.getHttpServer()).get('/health')
    expect(res2.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('los problemas de negocio salen como 422 con la lista de Problem', async () => {
    const res = await request(app.getHttpServer()).get('/__test/problems').expect(422)
    expect(res.body).toEqual({
      statusCode: 422,
      error: 'No se pudo procesar la solicitud',
      problems: [{ code: 'NO_INVOICES', message: 'Adjunta al menos una factura.' }],
    })
  })

  it('un error inesperado sale como 500 sin detalles internos', async () => {
    const res = await request(app.getHttpServer()).get('/__test/boom').expect(500)
    expect(res.body).toEqual({
      statusCode: 500,
      error: 'Error interno',
      message: 'Ocurrió un error inesperado. Inténtalo de nuevo.',
    })
  })

  it('un JSON mayor al límite sale como 413 en español', async () => {
    const res = await request(app.getHttpServer())
      .post('/__test/json')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ x: 'a'.repeat(300 * 1024) }))
      .expect(413)
    expect(res.body.message).toBe('El envío supera el tamaño máximo permitido.')
  })

  it('una ruta inexistente sale como 404 en español', async () => {
    const res = await request(app.getHttpServer()).get('/no-existe').expect(404)
    expect(res.body.error).toBe('No encontrado')
  })

  it('CORS solo acepta los orígenes configurados', async () => {
    const ok = await request(app.getHttpServer()).get('/health').set('origin', 'http://localhost:4321')
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:4321')
    const other = await request(app.getHttpServer()).get('/health').set('origin', 'https://evil.example')
    expect(other.headers['access-control-allow-origin']).toBeUndefined()
  })
})
```

Run: `pnpm --filter @anticipate/api exec vitest run --project api:unit src/app.test.ts`
Expected: FAIL, `Cannot find module './app.js'`.

- [ ] **Step 5: Implementar errores, IP del cliente y límite de envíos**

`apps/api/src/common/http-messages.es.ts`:
```ts
/** Textos en español de las respuestas HTTP genéricas. Los problemas de negocio vienen de `shared`. */
export const HTTP_ERRORS_ES: Record<number, string> = {
  400: 'Solicitud inválida',
  403: 'Acceso denegado',
  404: 'No encontrado',
  409: 'Conflicto',
  411: 'Falta el tamaño del envío',
  413: 'Envío demasiado grande',
  422: 'No se pudo procesar la solicitud',
  429: 'Demasiadas solicitudes',
  500: 'Error interno',
  503: 'Servicio no disponible',
}

export const HTTP_MESSAGES_ES = {
  payloadTooLarge: 'El envío supera el tamaño máximo permitido.',
  lengthRequired: 'El envío debe indicar su tamaño (Content-Length).',
  tooManyRequests: 'Hiciste demasiados envíos seguidos. Inténtalo de nuevo más tarde.',
  notFound: 'La ruta solicitada no existe.',
  unexpected: 'Ocurrió un error inesperado. Inténtalo de nuevo.',
} as const
```

`apps/api/src/common/problems.exception.ts`:
```ts
import { HttpException, HttpStatus } from '@nestjs/common'
import type { Problem } from '@anticipate/shared/errors'
import { HTTP_ERRORS_ES } from './http-messages.es.js'

/** Problemas de negocio (códigos de `shared`). Por defecto 422; 403 para Turnstile, 503 para infraestructura. */
export class ProblemsException extends HttpException {
  constructor(
    readonly problems: readonly Problem[],
    status: number = HttpStatus.UNPROCESSABLE_ENTITY,
  ) {
    super({ statusCode: status, error: HTTP_ERRORS_ES[status] ?? 'Error', problems }, status)
  }
}
```

`apps/api/src/common/problems.filter.ts`:
```ts
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common'
import { ThrottlerException } from '@nestjs/throttler'
import type { Response } from 'express'
import { HTTP_ERRORS_ES, HTTP_MESSAGES_ES } from './http-messages.es.js'
import { ProblemsException } from './problems.exception.js'

@Catch()
export class ProblemsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemsFilter.name)

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>()
    const send = (status: number, body: Record<string, unknown>) => {
      res.status(status).json({ statusCode: status, error: HTTP_ERRORS_ES[status] ?? 'Error', ...body })
    }

    if (exception instanceof ProblemsException) {
      send(exception.getStatus(), { problems: exception.problems })
      return
    }
    if (exception instanceof ThrottlerException) {
      send(HttpStatus.TOO_MANY_REQUESTS, { message: HTTP_MESSAGES_ES.tooManyRequests })
      return
    }
    // body-parser y multer marcan el exceso de tamaño con status 413 (o type entity.too.large).
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : typeof (exception as { status?: unknown })?.status === 'number'
          ? (exception as { status: number }).status
          : HttpStatus.INTERNAL_SERVER_ERROR
    if (status === HttpStatus.PAYLOAD_TOO_LARGE) {
      send(status, { message: HTTP_MESSAGES_ES.payloadTooLarge })
      return
    }
    if (status === HttpStatus.NOT_FOUND) {
      send(status, { message: HTTP_MESSAGES_ES.notFound })
      return
    }
    if (exception instanceof HttpException && status < 500) {
      const body = exception.getResponse()
      send(status, typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : { message: body })
      return
    }
    this.logger.error({ err: exception }, 'error no controlado')
    const finalStatus = status >= 500 ? status : HttpStatus.INTERNAL_SERVER_ERROR
    send(finalStatus, { message: HTTP_MESSAGES_ES.unexpected })
  }
}
```

`apps/api/src/common/client-ip.ts`:
```ts
import type { Request } from 'express'

/**
 * IP real del cliente. Con Cloudflare delante y el origen aceptando solo sus rangos, `CF-Connecting-IP`
 * es fiable; si no, se usa `req.ip`, que Express deriva de `trust proxy` (nunca `true`).
 */
export function resolveClientIp(req: Request, trustCloudflareHeaders: boolean): string {
  if (trustCloudflareHeaders) {
    const cf = req.get('cf-connecting-ip')?.trim()
    if (cf) return cf
  }
  return req.ip ?? req.socket.remoteAddress ?? 'desconocida'
}
```

`apps/api/src/common/submit-throttle.ts`:
```ts
import { type ExecutionContext, SetMetadata } from '@nestjs/common'

const SUBMIT_THROTTLE = 'anticipate:submit-throttle'

/** Marca una ruta pública de envío: además del límite general, aplica el límite de envíos por IP. */
export const SubmitThrottle = () => SetMetadata(SUBMIT_THROTTLE, true)

export const isSubmitRoute = (context: ExecutionContext): boolean =>
  Reflect.getMetadata(SUBMIT_THROTTLE, context.getHandler()) === true
```

- [ ] **Step 6: Implementar la salud, el módulo raíz y `createApp`**

`apps/api/src/health/health.controller.ts`:
```ts
import { Controller, Get } from '@nestjs/common'
import { HealthCheck, HealthCheckService } from '@nestjs/terminus'
import { SkipThrottle } from '@nestjs/throttler'

@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthCheckService) {}

  @Get()
  @HealthCheck()
  check() {
    // Las Tareas 5 y 6 agregan los indicadores de base de datos y almacenamiento.
    return this.health.check([])
  }
}
```

`apps/api/src/health/health.module.ts`:
```ts
import { Module } from '@nestjs/common'
import { TerminusModule } from '@nestjs/terminus'
import { HealthController } from './health.controller.js'

@Module({ imports: [TerminusModule], controllers: [HealthController] })
export class HealthModule {}
```

`apps/api/src/app.module.ts`:
```ts
import { randomUUID } from 'node:crypto'
import { type DynamicModule, Module, type Type } from '@nestjs/common'
import { APP_FILTER, APP_GUARD } from '@nestjs/core'
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'
import type { Request } from 'express'
import { LoggerModule } from 'nestjs-pino'
import { resolveClientIp } from './common/client-ip.js'
import { ProblemsFilter } from './common/problems.filter.js'
import { isSubmitRoute } from './common/submit-throttle.js'
import type { AppConfig } from './config/app-config.js'
import { AppConfigModule } from './config/config.module.js'
import { HealthModule } from './health/health.module.js'

@Module({})
export class AppModule {
  static register(config: AppConfig, extraModules: Type[] = []): DynamicModule {
    return {
      module: AppModule,
      imports: [
        AppConfigModule.register(config),
        LoggerModule.forRoot({
          pinoHttp: {
            level: config.logLevel,
            genReqId: (req, res) => {
              const incoming = req.headers['x-request-id']
              const id = typeof incoming === 'string' && /^[\w-]{1,64}$/.test(incoming) ? incoming : randomUUID()
              res.setHeader('x-request-id', id)
              return id
            },
            redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-turnstile-token"]'],
            autoLogging: { ignore: (req) => req.url === '/health' },
            ...(config.nodeEnv === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
          },
        }),
        ThrottlerModule.forRoot({
          throttlers: [
            { name: 'default', limit: config.throttle.defaultLimit, ttl: config.throttle.defaultTtlMs },
            {
              name: 'submit',
              limit: config.throttle.submitLimit,
              ttl: config.throttle.submitTtlMs,
              skipIf: (context) => !isSubmitRoute(context),
            },
          ],
          getTracker: (req) => resolveClientIp(req as unknown as Request, config.trustCloudflareHeaders),
        }),
        HealthModule,
        // Las tareas siguientes agregan aquí: PrismaModule, StorageModule, PayersModule,
        // NotificationsModule (+ OutboxPollerModule si config.outbox.pollerEnabled) y AdvanceRequestsModule.
        ...extraModules,
      ],
      providers: [
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_FILTER, useClass: ProblemsFilter },
      ],
    }
  }
}
```

`apps/api/src/app.ts`:
```ts
import 'reflect-metadata'
import { BadRequestException, StandardSchemaValidationPipe, type Type } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Logger } from 'nestjs-pino'
import { AppModule } from './app.module.js'
import { HTTP_ERRORS_ES } from './common/http-messages.es.js'
import type { AppConfig } from './config/app-config.js'

export type CreateAppOptions = { extraModules?: Type[] }

/** Opciones de creación comunes a `createApp` y a la app de pruebas. */
export const NEST_APP_OPTIONS = { bufferLogs: true, abortOnError: false, bodyParser: false } as const

/**
 * Todo lo transversal de la app. Lo usan `createApp` (producción) y el helper de tests, que arma el
 * módulo con `@nestjs/testing` para reemplazar proveedores: así ambos prueban la misma configuración.
 */
export function configureApp(app: NestExpressApplication, config: AppConfig): NestExpressApplication {
  app.useLogger(app.get(Logger))
  app.set('trust proxy', config.trustProxy)
  app.set('query parser', 'simple')
  app.disable('x-powered-by')
  app.enableCors({ origin: config.corsOrigins, credentials: true, maxAge: 600 })
  app.useBodyParser('json', { limit: '256kb' })
  app.useGlobalPipes(
    new StandardSchemaValidationPipe({
      exceptionFactory: (issues) =>
        new BadRequestException({
          statusCode: 400,
          error: HTTP_ERRORS_ES[400],
          errors: issues.map((issue) => ({
            field: (issue.path ?? [])
              .map((p) => (typeof p === 'object' && p !== null ? String(p.key) : String(p)))
              .join('.'),
            message: issue.message,
          })),
        }),
    }),
  )
  app.enableShutdownHooks()
  return app
}

export async function createApp(config: AppConfig, options: CreateAppOptions = {}) {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register(config, options.extraModules),
    NEST_APP_OPTIONS,
  )
  return configureApp(app, config)
}
```
`src` nunca importa `@nestjs/testing` (es dependencia de desarrollo y no está en la imagen de producción).

`apps/api/src/main.ts`:
```ts
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { createApp } from './app.js'
import { parseConfig } from './config/app-config.js'

if (process.env.NODE_ENV !== 'production') {
  try {
    process.loadEnvFile()
  } catch {
    // Sin .env: se usan las variables del entorno.
  }
}

const config = parseConfig(process.env)
const app = await createApp(config)
if (config.nodeEnv !== 'production') {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('Anticipate API').setVersion('0.1.0').build(),
  )
  SwaggerModule.setup('docs', app, document)
}
await app.listen(config.port)
```

`apps/api/.env.example` (copiar a `.env`; los valores apuntan a Docker Compose):
```dotenv
NODE_ENV=development
PORT=4000
LOG_LEVEL=info
DATABASE_URL=postgresql://anticipate:anticipate@127.0.0.1:5432/anticipate
CORS_ORIGINS=http://localhost:4321,http://localhost:3000
TRUST_PROXY=loopback
TRUST_CLOUDFLARE_HEADERS=false
S3_ENDPOINT=http://127.0.0.1:9090
S3_REGION=us-east-1
S3_BUCKET=anticipate-local
S3_ACCESS_KEY_ID=local
S3_SECRET_ACCESS_KEY=local
S3_FORCE_PATH_STYLE=true
MAIL_TRANSPORT=smtp
SMTP_HOST=127.0.0.1
SMTP_PORT=1025
BREVO_API_KEY=
MAIL_FROM_EMAIL=solicitudes@anticipate.local
MAIL_FROM_NAME=Anticipate
TEAM_NOTIFICATION_EMAIL=equipo@anticipate.local
ADMIN_BASE_URL=http://localhost:3000
# Clave de prueba de Cloudflare: siempre aprueba. Producción: la del panel de Turnstile.
TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
TURNSTILE_EXPECTED_HOSTNAME=
PUBLIC_CODE_PREFIX=ANT
OUTBOX_POLLER_ENABLED=true
# Solo para `pnpm db:seed`: usuario administrador inicial.
SEED_ADMIN_EMAIL=admin@anticipate.local
SEED_ADMIN_PASSWORD=
```

`apps/api/.env.test.example` (copiar a `.env.test`; lo usan los tests de integración):
```dotenv
DATABASE_URL_TEST=postgresql://anticipate:anticipate@127.0.0.1:5432/anticipate_test
S3_ENDPOINT=http://127.0.0.1:9090
S3_BUCKET=anticipate-local
SMTP_HOST=127.0.0.1
SMTP_PORT=1025
MAILPIT_API_URL=http://127.0.0.1:8025
```

- [ ] **Step 7: Verificar**

Run: `pnpm --filter @anticipate/api exec vitest run --project api:unit && pnpm --filter @anticipate/api typecheck && pnpm --filter @anticipate/api build && pnpm lint:fix && pnpm lint`
Expected: 12 tests PASS; `dist/main.js` existe. Si una API de NestJS 12 difiere de lo escrito (por ejemplo la firma de `exceptionFactory` o `skipIf`), adaptar el código sin cambiar lo que prueban los tests y anotarlo en el reporte.

Run: `cp -n apps/api/.env.example apps/api/.env && (cd apps/api && timeout 15 node dist/main.js & sleep 6; curl -s http://127.0.0.1:4000/health; kill %1)`
Expected: `{"status":"ok","info":{},"error":{},"details":{}}`.

- [ ] **Step 8: Commit**

```bash
git add apps/api pnpm-lock.yaml
git commit -m "feat(api): esqueleto nestjs con configuración validada, errores en español, límites y salud"
```

---

### Task 5: Prisma: esquema de 13 tablas, migración, seed y base de los tests de integración

**Files:**
- Create: `apps/api/prisma.config.ts`, `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/<timestamp>_init/migration.sql` (generado y editado), `apps/api/prisma/seed.ts`
- Create: `apps/api/src/prisma/prisma.module.ts`, `apps/api/src/prisma/prisma.service.ts`, `apps/api/src/prisma/db-values.ts`, `apps/api/src/prisma/prisma-errors.ts`
- Create: `apps/api/test/integration/global-setup.ts`, `apps/api/test/support/db.ts`, `apps/api/test/support/factories.ts`
- Modify: `apps/api/package.json` (dependencias de Prisma y argon2, bloque `prisma`), `apps/api/src/app.module.ts`, `apps/api/src/health/health.controller.ts`, `apps/api/src/health/health.module.ts`
- Test: `apps/api/src/prisma/enums.test.ts`, `apps/api/src/prisma/db-values.test.ts`, `apps/api/test/integration/schema.test.ts`

**Interfaces:**
- Consumes: `APP_CONFIG` (Tarea 4); listas de enums, `normalizeAmount`, `Amount`, `IsoDate`, `isIsoDate` de `shared`.
- Produces:
  - Modelos Prisma `Payer`, `Supplier`, `LegalRepresentative`, `SupplierDocument`, `AdvanceRequest`, `Invoice`, `StoredFile`, `FollowUp`, `StatusHistory`, `Consent`, `User`, `AuditLog`, `OutboxEvent`, con columnas en `snake_case` y tablas en plural.
  - La secuencia `advance_request_code_seq` y el índice único parcial `invoices_active_invoice_key_key` sobre `invoices(invoice_key) WHERE active`.
  - `PrismaService` (extiende el cliente generado; `@Global` vía `PrismaModule`), `Tx` (tipo del cliente de transacción), `isUniqueViolation(error, indexName)`.
  - `isoDateToDb(IsoDate): Date`, `dbDateToIso(Date): IsoDate`, `decimalToAmount(Decimal): Amount`.
  - Para tests: `createTestPrisma()`, `truncateAll(prisma)`, y las fábricas `createPayer`, `createSupplier`, `createStoredFile`, `createAdvanceRequest`, `createInvoice`.

**Notas de Prisma 7 verificadas el 2026-09-24.** `prisma.config.ts` es obligatorio y Prisma 7 no carga `.env` solo. El cliente se genera con el generador `prisma-client` dentro de `src/generated/prisma` (ignorado por git) y se compila junto con la app. El adaptador `@prisma/adapter-pg` recibe un `pg.Pool` propio. El índice único parcial se declara en el esquema con la vista previa `partialIndexes`; escribirlo a mano en SQL lo detectaría como drift. La documentación por defecto de prisma.io ya es de la 8: usar la de `/docs/orm/v7/`.

- [ ] **Step 1: Dependencias y configuración de Prisma**

Agregar a `apps/api/package.json`:
```json
  "dependencies": {
    "@prisma/adapter-pg": "catalog:",
    "@prisma/client": "catalog:",
    "argon2": "catalog:",
    "pg": "catalog:"
  },
  "devDependencies": {
    "@types/pg": "catalog:",
    "prisma": "catalog:",
    "tsx": "catalog:"
  }
```
(fusionar con las existentes, en orden alfabético).

`apps/api/prisma.config.ts`:
```ts
import { defineConfig } from 'prisma/config'

// Prisma 7 no lee .env por su cuenta. En la imagen Docker no hay .env ni base al generar el cliente:
// `prisma generate` no se conecta, así que se deja una URL de relleno en vez de fallar al cargar.
try {
  process.loadEnvFile()
} catch {
  // Sin .env: se usan las variables del entorno.
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? 'postgresql://sin-configurar@127.0.0.1:5432/sin-configurar',
  },
})
```

Run: `pnpm install`
Expected: instala `prisma@7.10.0` exacto (no la 8). Comprobar con `pnpm --filter @anticipate/api exec prisma --version`.

- [ ] **Step 2: Escribir el esquema**

`apps/api/prisma/schema.prisma`:
```prisma
generator client {
  provider               = "prisma-client"
  output                 = "../src/generated/prisma"
  runtime                = "nodejs"
  moduleFormat           = "esm"
  generatedFileExtension = "ts"
  importFileExtension    = "js"
  previewFeatures        = ["partialIndexes"]
}

datasource db {
  provider = "postgresql"
}

// Los valores de cada enum son los de @anticipate/shared; src/prisma/enums.test.ts lo verifica.

enum AdvanceRequestStatus {
  NEW
  NO_ANSWER
  CONTACTED
  DOCUMENTS_PENDING
  UNDER_REVIEW
  QUOTE_SENT
  APPROVED
  DISBURSED
  REJECTED
  WITHDRAWN

  @@map("advance_request_status")
}

enum CloseReason {
  NO_RESPONSE
  SPAM_OR_INVALID
  SUPPLIER_WITHDREW
  INVALID_DOCUMENTS
  INVOICE_NOT_ELIGIBLE
  UNACCEPTABLE_RISK
  OTHER

  @@map("close_reason")
}

enum Currency {
  PEN
  USD

  @@map("currency")
}

enum PaymentTerms {
  CASH
  CREDIT

  @@map("payment_terms")
}

enum CavaliRegistration {
  YES
  NO
  UNKNOWN

  @@map("cavali_registration")
}

enum ContactTimeSlot {
  MORNING
  AFTERNOON
  ANY

  @@map("contact_time_slot")
}

enum SupplierDocumentType {
  REPRESENTATIVE_ID
  POWER_OF_ATTORNEY_CERTIFICATE
  MASTER_AGREEMENT
  OTHER

  @@map("supplier_document_type")
}

enum SupplierDocumentStatus {
  PENDING_REVIEW
  APPROVED
  REJECTED

  @@map("supplier_document_status")
}

enum FollowUpChannel {
  CALL
  WHATSAPP
  EMAIL
  OTHER

  @@map("follow_up_channel")
}

enum ConsentType {
  TERMS
  PERSONAL_DATA

  @@map("consent_type")
}

enum Role {
  AGENT
  ADMIN

  @@map("role")
}

enum OutboxNotification {
  SUPPLIER_CONFIRMATION
  TEAM_ALERT

  @@map("outbox_notification")
}

enum OutboxStatus {
  PENDING
  PROCESSING
  SENT
  FAILED

  @@map("outbox_status")
}

model Payer {
  id                String           @id @default(uuid(7)) @db.Uuid
  slug              String           @unique @db.VarChar(60)
  ruc               String           @unique @db.VarChar(11)
  legalName         String           @map("legal_name") @db.VarChar(200)
  shortName         String           @map("short_name") @db.VarChar(40)
  advancePercent    Decimal          @map("advance_percent") @db.Decimal(5, 2)
  minTermDays       Int              @map("min_term_days")
  maxInvoices       Int              @map("max_invoices")
  allowedCurrencies Currency[]       @map("allowed_currencies")
  accentColor       String           @map("accent_color") @db.VarChar(7)
  logoUrl           String?          @map("logo_url")
  texts             Json             @default("{}")
  active            Boolean          @default(true)
  createdAt         DateTime         @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt         DateTime         @updatedAt @map("updated_at") @db.Timestamptz(3)
  advanceRequests   AdvanceRequest[]

  @@map("payers")
}

model Supplier {
  id                   String                @id @default(uuid(7)) @db.Uuid
  ruc                  String                @unique @db.VarChar(11)
  legalName            String                @map("legal_name") @db.VarChar(200)
  createdAt            DateTime              @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt            DateTime              @updatedAt @map("updated_at") @db.Timestamptz(3)
  advanceRequests      AdvanceRequest[]
  legalRepresentatives LegalRepresentative[]
  documents            SupplierDocument[]

  @@map("suppliers")
}

model LegalRepresentative {
  id         String             @id @default(uuid(7)) @db.Uuid
  supplierId String             @map("supplier_id") @db.Uuid
  fullName   String             @map("full_name") @db.VarChar(120)
  dni        String             @db.VarChar(8)
  jobTitle   String?            @map("job_title") @db.VarChar(80)
  active     Boolean            @default(true)
  createdAt  DateTime           @default(now()) @map("created_at") @db.Timestamptz(3)
  supplier   Supplier           @relation(fields: [supplierId], references: [id])
  documents  SupplierDocument[]

  @@unique([supplierId, dni])
  @@map("legal_representatives")
}

model SupplierDocument {
  id               String                 @id @default(uuid(7)) @db.Uuid
  supplierId       String                 @map("supplier_id") @db.Uuid
  representativeId String?                @map("representative_id") @db.Uuid
  type             SupplierDocumentType
  status           SupplierDocumentStatus @default(PENDING_REVIEW)
  fileId           String                 @unique @map("file_id") @db.Uuid
  issuedOn         DateTime?              @map("issued_on") @db.Date
  validUntil       DateTime?              @map("valid_until") @db.Date
  reviewedById     String?                @map("reviewed_by_id") @db.Uuid
  reviewedAt       DateTime?              @map("reviewed_at") @db.Timestamptz(3)
  createdAt        DateTime               @default(now()) @map("created_at") @db.Timestamptz(3)
  supplier         Supplier               @relation(fields: [supplierId], references: [id])
  representative   LegalRepresentative?   @relation(fields: [representativeId], references: [id])
  file             StoredFile             @relation(fields: [fileId], references: [id])
  reviewedBy       User?                  @relation(fields: [reviewedById], references: [id])

  @@index([supplierId])
  @@map("supplier_documents")
}

model AdvanceRequest {
  id                    String               @id @default(uuid(7)) @db.Uuid
  publicCode            String               @unique @map("public_code") @db.VarChar(24)
  payerId               String               @map("payer_id") @db.Uuid
  supplierId            String               @map("supplier_id") @db.Uuid
  status                AdvanceRequestStatus @default(NEW)
  contactFullName       String               @map("contact_full_name") @db.VarChar(120)
  contactDni            String               @map("contact_dni") @db.VarChar(8)
  contactMobile         String               @map("contact_mobile") @db.VarChar(9)
  contactEmail          String               @map("contact_email") @db.VarChar(254)
  isLegalRepresentative Boolean              @map("is_legal_representative")
  contactJobTitle       String?              @map("contact_job_title") @db.VarChar(80)
  contactTimeSlot       ContactTimeSlot      @map("contact_time_slot")
  requestedAmount       Decimal              @map("requested_amount") @db.Decimal(14, 2)
  currency              Currency
  purpose               String?              @db.VarChar(500)
  cavaliRegistration    CavaliRegistration   @map("cavali_registration")
  utm                   Json?
  referrer              String?              @db.VarChar(2000)
  closeReason           CloseReason?         @map("close_reason")
  closeReasonDetail     String?              @map("close_reason_detail") @db.VarChar(500)
  assignedToId          String?              @map("assigned_to_id") @db.Uuid
  version               Int                  @default(1)
  createdAt             DateTime             @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt             DateTime             @updatedAt @map("updated_at") @db.Timestamptz(3)
  payer                 Payer                @relation(fields: [payerId], references: [id])
  supplier              Supplier             @relation(fields: [supplierId], references: [id])
  assignedTo            User?                @relation("AssignedAdvanceRequests", fields: [assignedToId], references: [id])
  invoices              Invoice[]
  followUps             FollowUp[]
  statusHistory         StatusHistory[]
  consents              Consent[]
  outboxEvents          OutboxEvent[]

  @@index([status, createdAt])
  @@index([payerId, createdAt])
  @@index([supplierId])
  @@map("advance_requests")
}

model Invoice {
  id               String         @id @default(uuid(7)) @db.Uuid
  advanceRequestId String         @map("advance_request_id") @db.Uuid
  documentType     String         @map("document_type") @db.VarChar(2)
  seriesNumber     String         @map("series_number") @db.VarChar(20)
  /// Clave canónica de `invoiceKey` de shared: RUC emisor + serie + correlativo sin ceros a la izquierda.
  invoiceKey       String         @map("invoice_key") @db.VarChar(40)
  issuerRuc        String         @map("issuer_ruc") @db.VarChar(15)
  issuerName       String         @map("issuer_name") @db.VarChar(1500)
  recipientRuc     String         @map("recipient_ruc") @db.VarChar(15)
  paymentTerms     PaymentTerms   @map("payment_terms")
  total            Decimal        @db.Decimal(14, 2)
  netPendingAmount Decimal        @map("net_pending_amount") @db.Decimal(14, 2)
  currency         Currency
  issueDate        DateTime       @map("issue_date") @db.Date
  dueDate          DateTime       @map("due_date") @db.Date
  installments     Json
  detraction       Json?
  signed           Boolean
  xmlFileId        String         @unique @map("xml_file_id") @db.Uuid
  pdfFileId        String?        @unique @map("pdf_file_id") @db.Uuid
  active           Boolean        @default(true)
  createdAt        DateTime       @default(now()) @map("created_at") @db.Timestamptz(3)
  advanceRequest   AdvanceRequest @relation(fields: [advanceRequestId], references: [id])
  xmlFile          StoredFile     @relation("InvoiceXml", fields: [xmlFileId], references: [id])
  pdfFile          StoredFile?    @relation("InvoicePdf", fields: [pdfFileId], references: [id])

  /// Una factura no puede estar en dos solicitudes vivas (D26). `active` se apaga al cerrar la solicitud.
  @@unique([invoiceKey], where: raw("active"), map: "invoices_active_invoice_key_key")
  @@index([advanceRequestId])
  @@map("invoices")
}

model StoredFile {
  id               String            @id @default(uuid(7)) @db.Uuid
  key              String            @unique @db.VarChar(512)
  contentType      String            @map("content_type") @db.VarChar(100)
  sizeBytes        Int               @map("size_bytes")
  sha256           String            @db.Char(64)
  originalName     String?           @map("original_name") @db.VarChar(255)
  createdAt        DateTime          @default(now()) @map("created_at") @db.Timestamptz(3)
  invoiceXml       Invoice?          @relation("InvoiceXml")
  invoicePdf       Invoice?          @relation("InvoicePdf")
  supplierDocument SupplierDocument?

  @@map("stored_files")
}

model FollowUp {
  id               String          @id @default(uuid(7)) @db.Uuid
  advanceRequestId String          @map("advance_request_id") @db.Uuid
  userId           String          @map("user_id") @db.Uuid
  channel          FollowUpChannel
  note             String          @db.VarChar(2000)
  nextActionAt     DateTime?       @map("next_action_at") @db.Timestamptz(3)
  createdAt        DateTime        @default(now()) @map("created_at") @db.Timestamptz(3)
  advanceRequest   AdvanceRequest  @relation(fields: [advanceRequestId], references: [id])
  user             User            @relation(fields: [userId], references: [id])

  @@index([advanceRequestId, createdAt])
  @@map("follow_ups")
}

model StatusHistory {
  id                String                @id @default(uuid(7)) @db.Uuid
  advanceRequestId  String                @map("advance_request_id") @db.Uuid
  /// null en el registro inicial (la creación desde la landing).
  fromStatus        AdvanceRequestStatus? @map("from_status")
  toStatus          AdvanceRequestStatus  @map("to_status")
  /// null cuando el cambio lo hace el sistema.
  userId            String?               @map("user_id") @db.Uuid
  closeReason       CloseReason?          @map("close_reason")
  closeReasonDetail String?               @map("close_reason_detail") @db.VarChar(500)
  createdAt         DateTime              @default(now()) @map("created_at") @db.Timestamptz(3)
  advanceRequest    AdvanceRequest        @relation(fields: [advanceRequestId], references: [id])
  user              User?                 @relation(fields: [userId], references: [id])

  @@index([advanceRequestId, createdAt])
  @@map("status_history")
}

model Consent {
  id               String         @id @default(uuid(7)) @db.Uuid
  advanceRequestId String         @map("advance_request_id") @db.Uuid
  type             ConsentType
  documentVersion  String         @map("document_version") @db.VarChar(20)
  ip               String         @db.VarChar(45)
  acceptedAt       DateTime       @map("accepted_at") @db.Timestamptz(3)
  advanceRequest   AdvanceRequest @relation(fields: [advanceRequestId], references: [id])

  @@unique([advanceRequestId, type])
  @@map("consents")
}

model User {
  id                   String             @id @default(uuid(7)) @db.Uuid
  email                String             @unique @db.VarChar(254)
  fullName             String             @map("full_name") @db.VarChar(120)
  passwordHash         String             @map("password_hash")
  role                 Role
  active               Boolean            @default(true)
  createdAt            DateTime           @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt            DateTime           @updatedAt @map("updated_at") @db.Timestamptz(3)
  assignedRequests     AdvanceRequest[]   @relation("AssignedAdvanceRequests")
  followUps            FollowUp[]
  statusChanges        StatusHistory[]
  reviewedDocuments    SupplierDocument[]
  auditLogs            AuditLog[]

  @@map("users")
}

model AuditLog {
  id        String   @id @default(uuid(7)) @db.Uuid
  userId    String?  @map("user_id") @db.Uuid
  action    String   @db.VarChar(60)
  entity    String   @db.VarChar(60)
  entityId  String?  @map("entity_id") @db.Uuid
  detail    Json?
  ip        String?  @db.VarChar(45)
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  user      User?    @relation(fields: [userId], references: [id])

  @@index([entity, entityId])
  @@map("audit_logs")
}

model OutboxEvent {
  id                String             @id @default(uuid(7)) @db.Uuid
  advanceRequestId  String             @map("advance_request_id") @db.Uuid
  notification      OutboxNotification
  /// Tipo del evento de dominio de shared (`advance-request.created`, …); el payload es ese evento.
  eventType         String             @map("event_type") @db.VarChar(60)
  payload           Json
  status            OutboxStatus       @default(PENDING)
  attempts          Int                @default(0)
  maxAttempts       Int                @map("max_attempts")
  nextAttemptAt     DateTime           @default(now()) @map("next_attempt_at") @db.Timestamptz(3)
  lockedUntil       DateTime?          @map("locked_until") @db.Timestamptz(3)
  lockedBy          String?            @map("locked_by") @db.VarChar(120)
  lastError         String?            @map("last_error") @db.VarChar(2000)
  sentAt            DateTime?          @map("sent_at") @db.Timestamptz(3)
  providerMessageId String?            @map("provider_message_id") @db.VarChar(255)
  createdAt         DateTime           @default(now()) @map("created_at") @db.Timestamptz(3)
  advanceRequest    AdvanceRequest     @relation(fields: [advanceRequestId], references: [id])

  @@index([status, nextAttemptAt], map: "outbox_events_due_idx")
  @@map("outbox_events")
}
```

Run: `pnpm --filter @anticipate/api exec prisma validate && pnpm --filter @anticipate/api db:generate`
Expected: esquema válido; cliente generado en `apps/api/src/generated/prisma/`. Si la sintaxis `where: raw("active")` no es aceptada, usar la forma de objeto `where: { active: true }` que documenta Prisma 7.4+, y anotarlo.

- [ ] **Step 3: Migración inicial con la secuencia del código público**

Run: `cp -n apps/api/.env.example apps/api/.env && pnpm infra:up && pnpm --filter @anticipate/api db:migrate:create --name init`
Expected: `apps/api/prisma/migrations/<timestamp>_init/migration.sql` creado sin aplicar.

Agregar al principio de ese `migration.sql`:
```sql
-- Secuencia del código público ANT-{año}-{secuencia} (STACK §9). La API arma el texto con
-- formatPublicCode de shared; la secuencia no se reinicia por año.
CREATE SEQUENCE "advance_request_code_seq" AS bigint START WITH 1 INCREMENT BY 1 NO CYCLE;
```

Comprobar que el índice parcial quedó en el SQL generado:
Run: `grep -n 'invoices_active_invoice_key_key' apps/api/prisma/migrations/*_init/migration.sql`
Expected: una línea `CREATE UNIQUE INDEX "invoices_active_invoice_key_key" ON "invoices"("invoice_key") WHERE active;` (o equivalente con paréntesis).

Run: `pnpm --filter @anticipate/api db:migrate && pnpm --filter @anticipate/api exec prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --exit-code`
Expected: la migración se aplica; `migrate diff` termina con código 0 (sin drift).

- [ ] **Step 4: Tests unitarios de enums y conversiones que fallan**

`apps/api/src/prisma/enums.test.ts`:
```ts
import {
  ADVANCE_REQUEST_STATUSES,
  CAVALI_REGISTRATION,
  CLOSE_REASONS,
  CONTACT_TIME_SLOTS,
} from '@anticipate/shared/advance-request'
import { PAYMENT_TERMS } from '@anticipate/shared/invoice'
import { CURRENCIES } from '@anticipate/shared/money'
import { SUPPLIER_DOCUMENT_STATUSES, SUPPLIER_DOCUMENT_TYPES } from '@anticipate/shared/supplier-document'
import { ROLES } from '@anticipate/shared/user'
import { describe, expect, it } from 'vitest'
import * as Enums from '../generated/prisma/enums.js'

const values = (e: Record<string, string>) => Object.values(e).sort()
const sorted = (list: readonly string[]) => [...list].sort()

describe('los enums de la base coinciden con shared', () => {
  it.each([
    ['AdvanceRequestStatus', Enums.AdvanceRequestStatus, ADVANCE_REQUEST_STATUSES],
    ['CloseReason', Enums.CloseReason, CLOSE_REASONS],
    ['Currency', Enums.Currency, CURRENCIES],
    ['PaymentTerms', Enums.PaymentTerms, PAYMENT_TERMS],
    ['CavaliRegistration', Enums.CavaliRegistration, CAVALI_REGISTRATION],
    ['ContactTimeSlot', Enums.ContactTimeSlot, CONTACT_TIME_SLOTS],
    ['SupplierDocumentType', Enums.SupplierDocumentType, SUPPLIER_DOCUMENT_TYPES],
    ['SupplierDocumentStatus', Enums.SupplierDocumentStatus, SUPPLIER_DOCUMENT_STATUSES],
    ['Role', Enums.Role, ROLES],
  ] as const)('%s', (_name, prismaEnum, sharedList) => {
    expect(values(prismaEnum)).toEqual(sorted(sharedList))
  })
})
```
(Si el generador `prisma-client` exporta los enums desde otro archivo, por ejemplo `client.js`, ajustar el import.)

`apps/api/src/prisma/db-values.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { Prisma } from '../generated/prisma/client.js'
import { dbDateToIso, decimalToAmount, isoDateToDb } from './db-values.js'

describe('conversiones con la base', () => {
  it('una fecha de calendario va y vuelve sin correrse de día', () => {
    const db = isoDateToDb('2026-11-30')
    expect(db.toISOString()).toBe('2026-11-30T00:00:00.000Z')
    expect(dbDateToIso(db)).toBe('2026-11-30')
  })

  it('un Decimal de Prisma vuelve como Amount de dos decimales', () => {
    expect(decimalToAmount(new Prisma.Decimal('8496'))).toBe('8496.00')
    expect(decimalToAmount(new Prisma.Decimal('999999999999.99'))).toBe('999999999999.99')
  })

  it('rechaza un Decimal que no es un monto válido', () => {
    expect(() => decimalToAmount(new Prisma.Decimal('-1'))).toThrow(RangeError)
  })
})
```

Run: `pnpm --filter @anticipate/api exec vitest run --project api:unit src/prisma`
Expected: FAIL, `Cannot find module './db-values.js'`; el test de enums ya pasa (confirma que el esquema coincide).

- [ ] **Step 5: Implementar el servicio, las conversiones y los errores de Prisma**

`apps/api/src/prisma/db-values.ts`:
```ts
import { type IsoDate, isIsoDate } from '@anticipate/shared/dates'
import { type Amount, normalizeAmount } from '@anticipate/shared/money'
import type { Prisma } from '../generated/prisma/client.js'

/** Columna `@db.Date`: medianoche UTC del día de calendario. */
export function isoDateToDb(date: IsoDate): Date {
  return new Date(`${date}T00:00:00.000Z`)
}

export function dbDateToIso(date: Date): IsoDate {
  const iso = date.toISOString().slice(0, 10)
  if (!isIsoDate(iso)) throw new RangeError(`Fecha inválida en la base: ${iso}`)
  return iso
}

export function decimalToAmount(value: Prisma.Decimal): Amount {
  const amount = normalizeAmount(value.toFixed(2))
  if (amount === null) throw new RangeError(`Monto inválido en la base: ${value.toString()}`)
  return amount
}
```

`apps/api/src/prisma/prisma-errors.ts`:
```ts
/** ¿El error es una violación de un índice único concreto (P2002)? */
export function isUniqueViolation(error: unknown, indexName: string): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { code, meta } = error as { code?: unknown; meta?: unknown }
  return code === 'P2002' && JSON.stringify(meta ?? {}).includes(indexName)
}
```

`apps/api/src/prisma/prisma.service.ts`:
```ts
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { PrismaPg } from '@prisma/adapter-pg'
import pg from 'pg'
import type { AppConfig } from '../config/app-config.js'
import { APP_CONFIG } from '../config/config.module.js'
import { PrismaClient } from '../generated/prisma/client.js'

/** Cliente de transacción interactiva: el que reciben los casos de uso dentro de `$transaction`. */
export type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly pool: pg.Pool
  private readonly logger = new Logger(PrismaService.name)

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 10,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
    })
    super({ adapter: new PrismaPg(pool) })
    this.pool = pool
    this.pool.on('error', (err) => this.logger.error({ err }, 'error en el pool de PostgreSQL'))
  }

  async onModuleInit() {
    await this.$connect()
  }

  async onModuleDestroy() {
    await this.$disconnect()
    await this.pool.end()
  }
}
```

`apps/api/src/prisma/prisma.module.ts`:
```ts
import { Global, Module } from '@nestjs/common'
import { PrismaService } from './prisma.service.js'

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
```

Agregar `PrismaModule` a `imports` de `AppModule.register` (antes de `HealthModule`).

`apps/api/src/health/health.controller.ts` (reemplazo completo; el indicador de almacenamiento llega en la Tarea 6):
```ts
import { Controller, Get } from '@nestjs/common'
import { HealthCheck, HealthCheckService, HealthIndicatorService } from '@nestjs/terminus'
import { SkipThrottle } from '@nestjs/throttler'
import { PrismaService } from '../prisma/prisma.service.js'

const withTimeout = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`sin respuesta en ${ms} ms`)), ms)),
  ])

@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicators: HealthIndicatorService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([() => this.database()])
  }

  private async database() {
    const indicator = this.indicators.check('database')
    try {
      await withTimeout(this.prisma.$queryRaw`SELECT 1`, 1500)
      return indicator.up()
    } catch (error) {
      return indicator.down({ message: error instanceof Error ? error.message : 'error' })
    }
  }
}
```

Run: `pnpm --filter @anticipate/api exec vitest run --project api:unit`
Expected: los tests de `src/prisma` PASS. El test de `app.test.ts` ahora necesita la base: correrlo con `pnpm infra:up` hecho (usa `anticipate_test` vía `testEnv`); antes de la integración, aplicar migraciones a `anticipate_test` con el global-setup del paso 7.

- [ ] **Step 6: Seed idempotente**

`apps/api/prisma/seed.ts`:
```ts
import { PrismaPg } from '@prisma/adapter-pg'
import argon2 from 'argon2'
import pg from 'pg'
import { PrismaClient } from '../src/generated/prisma/client.js'

try {
  process.loadEnvFile()
} catch {
  // Sin .env: se usan las variables del entorno.
}

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('Falta DATABASE_URL para correr el seed.')

const pool = new pg.Pool({ connectionString: databaseUrl })
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) })

/**
 * Pagadores iniciales. DATOS DE EJEMPLO: el RUC, el porcentaje, el plazo mínimo y el máximo de
 * facturas de SEA deben reemplazarse por los acordados antes de salir a producción.
 */
const PAYERS = [
  {
    slug: 'sea',
    ruc: '20131312955',
    legalName: 'Servicios Energéticos Ambientales S.A.',
    shortName: 'SEA',
    advancePercent: '80.00',
    minTermDays: 15,
    maxInvoices: 10,
    allowedCurrencies: ['PEN', 'USD'] as const,
    accentColor: '#0E7C86',
    logoUrl: null,
    texts: {
      title: 'Adelanta tus facturas a SEA',
      subtitle: 'Cobra hoy lo que SEA te pagará al vencimiento',
    },
  },
]

try {
  for (const payer of PAYERS) {
    const data = { ...payer, allowedCurrencies: [...payer.allowedCurrencies] }
    await prisma.payer.upsert({ where: { slug: payer.slug }, create: data, update: data })
  }

  const adminEmail = process.env.SEED_ADMIN_EMAIL
  const adminPassword = process.env.SEED_ADMIN_PASSWORD
  if (adminEmail) {
    if (!adminPassword || adminPassword.length < 12) {
      throw new Error('SEED_ADMIN_PASSWORD es obligatoria y debe tener al menos 12 caracteres.')
    }
    const passwordHash = await argon2.hash(adminPassword, { type: argon2.argon2id })
    await prisma.user.upsert({
      where: { email: adminEmail },
      create: { email: adminEmail, fullName: 'Administrador', passwordHash, role: 'ADMIN' },
      update: {},
    })
  }
  console.log(`Seed listo: ${PAYERS.length} pagador(es)${adminEmail ? ' y el usuario administrador' : ''}.`)
} finally {
  await prisma.$disconnect()
  await pool.end()
}
```

Run: `sed -i 's/^SEED_ADMIN_PASSWORD=$/SEED_ADMIN_PASSWORD=cambiar-esta-clave-local/' apps/api/.env && pnpm db:seed && pnpm db:seed`
Expected: las dos corridas terminan con "Seed listo: 1 pagador(es) y el usuario administrador." (idempotente). Si `argon2` pide aprobar su script de instalación, usar `pnpm approve-builds`.

- [ ] **Step 7: Base de los tests de integración**

`apps/api/test/integration/global-setup.ts`:
```ts
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export default function setup() {
  // Local: apps/api/.env.test. CI: las variables vienen del job (loadEnvFile no pisa las existentes).
  try {
    process.loadEnvFile(fileURLToPath(new URL('../../.env.test', import.meta.url)))
  } catch {
    // Sin .env.test.
  }
  const url = process.env.DATABASE_URL_TEST
  if (!url) throw new Error('Falta DATABASE_URL_TEST. Copia apps/api/.env.test.example a .env.test y corre `pnpm infra:up`.')
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  })
}
```

`apps/api/test/support/db.ts`:
```ts
import { PrismaPg } from '@prisma/adapter-pg'
import pg from 'pg'
import { PrismaClient } from '../../src/generated/prisma/client.js'

export function createTestPrisma() {
  const url = process.env.DATABASE_URL_TEST
  if (!url) throw new Error('Falta DATABASE_URL_TEST')
  const pool = new pg.Pool({ connectionString: url, max: 4 })
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) })
  return {
    prisma,
    async close() {
      await prisma.$disconnect()
      await pool.end()
    },
  }
}

/** Deja la base vacía y la secuencia del código público en 1. */
export async function truncateAll(prisma: PrismaClient) {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`
  if (rows.length > 0) {
    const tables = rows.map((r) => `"public"."${r.tablename}"`).join(', ')
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`)
  }
  await prisma.$executeRawUnsafe('ALTER SEQUENCE "advance_request_code_seq" RESTART WITH 1')
}
```

`apps/api/test/support/factories.ts`:
```ts
import { createHash, randomUUID } from 'node:crypto'
import type { PrismaClient } from '../../src/generated/prisma/client.js'

export const SEA = {
  slug: 'sea',
  ruc: '20131312955',
  legalName: 'Servicios Energéticos Ambientales S.A.',
  shortName: 'SEA',
  advancePercent: '80.00',
  minTermDays: 15,
  maxInvoices: 10,
  allowedCurrencies: ['PEN', 'USD'] as ('PEN' | 'USD')[],
  accentColor: '#0E7C86',
  logoUrl: null,
  texts: { title: 'Adelanta tus facturas a SEA' },
}

export const createPayer = (prisma: PrismaClient, overrides: Partial<typeof SEA> & { active?: boolean } = {}) =>
  prisma.payer.create({ data: { ...SEA, ...overrides } })

export const createSupplier = (prisma: PrismaClient, ruc = '20100070970') =>
  prisma.supplier.create({ data: { ruc, legalName: 'PROVEEDOR EJEMPLO S.A.C.' } })

export const createStoredFile = (prisma: PrismaClient, contentType = 'application/xml') => {
  const id = randomUUID()
  return prisma.storedFile.create({
    data: { id, key: `test/${id}`, contentType, sizeBytes: 10, sha256: createHash('sha256').update(id).digest('hex') },
  })
}

let sequence = 0
export const createAdvanceRequest = (prisma: PrismaClient, payerId: string, supplierId: string) =>
  prisma.advanceRequest.create({
    data: {
      publicCode: `ANT-2026-${String(++sequence).padStart(6, '0')}-T`,
      payerId,
      supplierId,
      contactFullName: 'Ana Pérez',
      contactDni: '46728673',
      contactMobile: '987654321',
      contactEmail: 'ana@proveedor.pe',
      isLegalRepresentative: true,
      contactTimeSlot: 'MORNING',
      requestedAmount: '8000.00',
      currency: 'PEN',
      cavaliRegistration: 'UNKNOWN',
    },
  })

export const createInvoice = async (
  prisma: PrismaClient,
  advanceRequestId: string,
  overrides: { invoiceKey?: string; active?: boolean } = {},
) => {
  const xml = await createStoredFile(prisma)
  return prisma.invoice.create({
    data: {
      advanceRequestId,
      documentType: '01',
      seriesNumber: 'F001-123',
      invoiceKey: overrides.invoiceKey ?? '20100070970|F001-123',
      issuerRuc: '20100070970',
      issuerName: 'PROVEEDOR EJEMPLO S.A.C.',
      recipientRuc: '20131312955',
      paymentTerms: 'CREDIT',
      total: '11800.00',
      netPendingAmount: '10620.00',
      currency: 'PEN',
      issueDate: new Date('2026-09-01T00:00:00Z'),
      dueDate: new Date('2026-11-30T00:00:00Z'),
      installments: [{ id: 'Cuota001', amount: '10620.00', dueDate: '2026-11-30' }],
      signed: true,
      xmlFileId: xml.id,
      active: overrides.active ?? true,
    },
  })
}
```
(`'20100070970|F001-123'` es el formato que devuelve `invoiceKey` de shared: RUC emisor, barra vertical, serie y correlativo sin ceros a la izquierda.)

- [ ] **Step 8: Test de integración del esquema que falla**

`apps/api/test/integration/schema.test.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { isUniqueViolation } from '../../src/prisma/prisma-errors.js'
import { createTestPrisma, truncateAll } from '../support/db.js'
import { createAdvanceRequest, createInvoice, createPayer, createSupplier } from '../support/factories.js'

const db = createTestPrisma()
const { prisma } = db

beforeAll(async () => {
  await prisma.$connect()
})
beforeEach(async () => {
  await truncateAll(prisma)
})
afterAll(async () => {
  await db.close()
})

describe('esquema de la base', () => {
  it('una factura no puede estar activa en dos solicitudes', async () => {
    const payer = await createPayer(prisma)
    const supplier = await createSupplier(prisma)
    const first = await createAdvanceRequest(prisma, payer.id, supplier.id)
    const second = await createAdvanceRequest(prisma, payer.id, supplier.id)
    await createInvoice(prisma, first.id)

    const duplicate = await createInvoice(prisma, second.id).catch((e: unknown) => e)
    expect(isUniqueViolation(duplicate, 'invoices_active_invoice_key_key')).toBe(true)
  })

  it('al apagar la factura de la solicitud cerrada, otra solicitud puede tomarla', async () => {
    const payer = await createPayer(prisma)
    const supplier = await createSupplier(prisma)
    const first = await createAdvanceRequest(prisma, payer.id, supplier.id)
    const second = await createAdvanceRequest(prisma, payer.id, supplier.id)
    await createInvoice(prisma, first.id)
    await prisma.invoice.updateMany({ where: { advanceRequestId: first.id }, data: { active: false } })

    await expect(createInvoice(prisma, second.id)).resolves.toMatchObject({ active: true })
  })

  it('la secuencia del código público avanza sin repetirse', async () => {
    const next = async () =>
      (await prisma.$queryRaw<{ n: bigint }[]>`SELECT nextval('advance_request_code_seq') AS n`)[0]?.n
    expect(await next()).toBe(1n)
    expect(await next()).toBe(2n)
  })

  it('guarda montos en el límite de Decimal(14, 2) y la lista de monedas del pagador', async () => {
    const payer = await createPayer(prisma, { allowedCurrencies: ['USD'] })
    const supplier = await createSupplier(prisma)
    const request = await createAdvanceRequest(prisma, payer.id, supplier.id)
    await prisma.advanceRequest.update({ where: { id: request.id }, data: { requestedAmount: '999999999999.99' } })
    const stored = await prisma.advanceRequest.findUniqueOrThrow({ where: { id: request.id } })
    expect(stored.requestedAmount.toFixed(2)).toBe('999999999999.99')
    expect((await prisma.payer.findUniqueOrThrow({ where: { id: payer.id } })).allowedCurrencies).toEqual(['USD'])
  })
})
```

Run: `cp -n apps/api/.env.test.example apps/api/.env.test && pnpm --filter @anticipate/api test:integration`
Expected: el global-setup aplica las migraciones en `anticipate_test` y los 4 tests PASS. Si el primer test falla con otro código de error, revisar que el índice parcial exista con `\d invoices` en `psql`.

- [ ] **Step 9: Verificar y commit**

Run: `pnpm --filter @anticipate/api exec vitest run --project api:unit && pnpm --filter @anticipate/api typecheck && pnpm --filter @anticipate/api build && pnpm lint:fix && pnpm lint`
Expected: todo en verde (incluido `app.test.ts`, que ahora consulta `anticipate_test` en `/health`).

```bash
git add apps/api pnpm-lock.yaml pnpm-workspace.yaml
git commit -m "feat(api): esquema prisma de 13 tablas, migración inicial, seed y base de tests de integración"
```

---

### Task 6: Almacenamiento de archivos (S3Mock en local, R2 en producción)

**Files:**
- Create: `apps/api/src/storage/s3-client.factory.ts`, `apps/api/src/storage/storage.service.ts`, `apps/api/src/storage/storage-keys.ts`, `apps/api/src/storage/storage.module.ts`
- Modify: `apps/api/package.json` (dependencias S3), `apps/api/src/app.module.ts`, `apps/api/src/health/health.controller.ts`
- Test: `apps/api/src/storage/storage-keys.test.ts`, `apps/api/test/integration/storage.test.ts`

**Interfaces:**
- Consumes: `APP_CONFIG` (`config.storage`).
- Produces:
  - `StorageService` con `put(input: PutFileInput): Promise<StoredObject>`, `putAll(inputs): Promise<StoredObject[]>` (todo o nada: si una falla, borra las ya subidas y relanza), `deleteQuietly(keys): Promise<void>` (nunca lanza, registra), `exists(key): Promise<boolean>`, `downloadUrl(key, fileName): Promise<string>` (5 minutos) y `ping(): Promise<void>` (salud).
  - `PutFileInput = { key: string; body: Buffer; contentType: string }`, `StoredObject = { key: string; sizeBytes: number; sha256: string }`.
  - `storageKeys.invoiceXml(payerId, requestId, invoiceId)`, `storageKeys.invoicePdf(payerId, requestId, invoiceId)`, `storageKeys.supplierDocument(supplierId, documentId, ext)`: rutas de STACK §10, siempre con ids.

**Notas verificadas el 2026-09-24.** S3Mock 5.2.3 solo acepta rutas `endpoint/bucket/key` (`forcePathStyle: true`) y tolera las sumas de verificación por defecto del SDK, pero Cloudflare R2 no documenta el trailer `aws-chunked`: por eso el cliente usa `requestChecksumCalculation` y `responseChecksumValidation` en `WHEN_REQUIRED` en todos los entornos y los cuerpos se suben como `Buffer`. Se borra con `DeleteObject` unitario (sin cuerpo ni checksum) en vez de `DeleteObjects`. S3Mock no valida firmas ni expiración: el test afirma `X-Amz-Expires=300` en la URL y la expiración real se prueba en staging contra R2.

- [ ] **Step 1: Dependencias**

Agregar a `dependencies` de `apps/api/package.json`: `"@aws-sdk/client-s3": "catalog:"` y `"@aws-sdk/s3-request-presigner": "catalog:"`.
Run: `pnpm install`

- [ ] **Step 2: Test de rutas que falla**

`apps/api/src/storage/storage-keys.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { storageKeys } from './storage-keys.js'

const p = '0b4e6c2d-5b1a-4f6e-8c2d-1a2b3c4d5e6f'
const r = '6f1c2c1e-3b7d-4c39-9a3e-7d2f9d8e1a11'
const i = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'

describe('storageKeys', () => {
  it('arma las rutas de facturas con ids', () => {
    expect(storageKeys.invoiceXml(p, r, i)).toBe(`payers/${p}/advance-requests/${r}/invoices/${i}.xml`)
    expect(storageKeys.invoicePdf(p, r, i)).toBe(`payers/${p}/advance-requests/${r}/invoices/${i}.pdf`)
  })

  it('arma la ruta de documentos del proveedor con extensión en minúsculas', () => {
    expect(storageKeys.supplierDocument(p, i, 'PDF')).toBe(`suppliers/${p}/documents/${i}.pdf`)
  })

  it('rechaza cualquier segmento que no sea un uuid', () => {
    expect(() => storageKeys.invoiceXml('../../etc', r, i)).toThrow(RangeError)
    expect(() => storageKeys.supplierDocument(p, i, 'pdf/../x')).toThrow(RangeError)
  })
})
```

Run: `pnpm --filter @anticipate/api exec vitest run --project api:unit src/storage`
Expected: FAIL, `Cannot find module './storage-keys.js'`.

- [ ] **Step 3: Implementar rutas, cliente y servicio**

`apps/api/src/storage/storage-keys.ts`:
```ts
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EXTENSION = /^[a-z0-9]{1,8}$/

function id(value: string): string {
  if (!UUID.test(value)) throw new RangeError(`Segmento de ruta inválido: ${value}`)
  return value.toLowerCase()
}

function extension(value: string): string {
  const ext = value.toLowerCase()
  if (!EXTENSION.test(ext)) throw new RangeError(`Extensión inválida: ${value}`)
  return ext
}

/** Rutas del almacenamiento (STACK §10). Siempre ids, nunca slugs ni nombres del usuario. */
export const storageKeys = {
  invoiceXml: (payerId: string, requestId: string, invoiceId: string) =>
    `payers/${id(payerId)}/advance-requests/${id(requestId)}/invoices/${id(invoiceId)}.xml`,
  invoicePdf: (payerId: string, requestId: string, invoiceId: string) =>
    `payers/${id(payerId)}/advance-requests/${id(requestId)}/invoices/${id(invoiceId)}.pdf`,
  supplierDocument: (supplierId: string, documentId: string, ext: string) =>
    `suppliers/${id(supplierId)}/documents/${id(documentId)}.${extension(ext)}`,
}
```

`apps/api/src/storage/s3-client.factory.ts`:
```ts
import { S3Client } from '@aws-sdk/client-s3'
import type { AppConfig } from '../config/app-config.js'

export function createS3Client(storage: AppConfig['storage']): S3Client {
  return new S3Client({
    ...(storage.endpoint ? { endpoint: storage.endpoint } : {}),
    region: storage.region,
    forcePathStyle: storage.forcePathStyle,
    credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey },
    // R2 no documenta el trailer aws-chunked ni las sumas por defecto del SDK: un solo camino
    // de código, probado contra S3Mock y recomendado por AWS para servicios compatibles.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
}
```

`apps/api/src/storage/storage.service.ts`:
```ts
import { createHash } from 'node:crypto'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common'
import type { AppConfig } from '../config/app-config.js'
import { APP_CONFIG } from '../config/config.module.js'
import { createS3Client } from './s3-client.factory.js'

export type PutFileInput = { key: string; body: Buffer; contentType: string }
export type StoredObject = { key: string; sizeBytes: number; sha256: string }

export const DOWNLOAD_URL_TTL_SECONDS = 300

/** Único punto de acceso al almacenamiento (STACK §8). */
@Injectable()
export class StorageService implements OnModuleDestroy {
  private readonly logger = new Logger(StorageService.name)
  private readonly s3: S3Client
  private readonly bucket: string

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.s3 = createS3Client(config.storage)
    this.bucket = config.storage.bucket
  }

  onModuleDestroy() {
    this.s3.destroy()
  }

  async put(input: PutFileInput): Promise<StoredObject> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        ContentLength: input.body.byteLength,
      }),
    )
    return {
      key: input.key,
      sizeBytes: input.body.byteLength,
      sha256: createHash('sha256').update(input.body).digest('hex'),
    }
  }

  /** Sube todo o nada: si una subida falla, borra las que sí se hicieron y relanza el error. */
  async putAll(inputs: readonly PutFileInput[]): Promise<StoredObject[]> {
    const results = await Promise.allSettled(inputs.map((input) => this.put(input)))
    const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failure) {
      const uploaded = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value.key] : []))
      await this.deleteQuietly(uploaded)
      throw failure.reason
    }
    return results.map((r) => (r as PromiseFulfilledResult<StoredObject>).value)
  }

  /** Borra sin lanzar: se usa para limpiar después de un fallo, donde el error original es el que importa. */
  async deleteQuietly(keys: readonly string[]): Promise<void> {
    const results = await Promise.allSettled(
      keys.map((Key) => this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key }))),
    )
    results.forEach((r, i) => {
      if (r.status === 'rejected') this.logger.error({ err: r.reason, key: keys[i] }, 'no se pudo borrar un archivo')
    })
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      return true
    } catch (error) {
      if ((error as { name?: string }).name === 'NotFound') return false
      throw error
    }
  }

  downloadUrl(key: string, fileName: string): Promise<string> {
    const safeName = fileName.replace(/[^\w.\- ]/g, '_').slice(0, 120)
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: `attachment; filename="${safeName}"`,
      }),
      { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
    )
  }

  async ping(): Promise<void> {
    await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }))
  }
}
```

`apps/api/src/storage/storage.module.ts`:
```ts
import { Global, Module } from '@nestjs/common'
import { StorageService } from './storage.service.js'

@Global()
@Module({ providers: [StorageService], exports: [StorageService] })
export class StorageModule {}
```

Agregar `StorageModule` a `AppModule.register`. En `health.controller.ts`, inyectar `StorageService` y agregar un segundo indicador `storage` con el mismo patrón que `database`, llamando a `this.storage.ping()` con `withTimeout(…, 1500)`; `check()` pasa a `this.health.check([() => this.database(), () => this.storage()])` (renombrar el método privado a `storageStatus` para no chocar con la propiedad).

- [ ] **Step 4: Test de integración que falla**

`apps/api/test/integration/storage.test.ts`:
```ts
import { createHash, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { StorageService } from '../../src/storage/storage.service.js'
import { testConfig } from '../support/config.js'

const storage = new StorageService(testConfig())
const key = (name: string) => `tests/${randomUUID()}/${name}`

afterAll(() => storage.onModuleDestroy())

describe('StorageService contra S3Mock', () => {
  it('sube, calcula el sha256 y confirma que existe', async () => {
    const k = key('a.xml')
    const stored = await storage.put({ key: k, body: Buffer.from('<Invoice/>'), contentType: 'application/xml' })
    expect(stored).toEqual({
      key: k,
      sizeBytes: 10,
      sha256: createHash('sha256').update('<Invoice/>').digest('hex'),
    })
    expect(await storage.exists(k)).toBe(true)
  })

  it('borra sin lanzar, incluso claves que no existen', async () => {
    const k = key('b.xml')
    await storage.put({ key: k, body: Buffer.from('x'), contentType: 'application/xml' })
    await expect(storage.deleteQuietly([k, key('nunca-existio.xml')])).resolves.toBeUndefined()
    expect(await storage.exists(k)).toBe(false)
  })

  it('putAll es todo o nada', async () => {
    const ok = key('ok.pdf')
    // La segunda subida falla a propósito; la primera, que sí llegó a S3Mock, debe quedar borrada.
    const failing = new StorageService(testConfig())
    const originalPut = failing.put.bind(failing)
    failing.put = async (input) => {
      if (input.key.endsWith('falla.pdf')) throw new Error('subida rechazada')
      return originalPut(input)
    }
    await expect(
      failing.putAll([
        { key: ok, body: Buffer.from('%PDF-1.7'), contentType: 'application/pdf' },
        { key: key('falla.pdf'), body: Buffer.from('%PDF-1.7'), contentType: 'application/pdf' },
      ]),
    ).rejects.toThrow('subida rechazada')
    expect(await storage.exists(ok)).toBe(false)
    failing.onModuleDestroy()
  })

  it('firma enlaces de descarga de 5 minutos', async () => {
    const k = key('c.pdf')
    await storage.put({ key: k, body: Buffer.from('%PDF-1.7'), contentType: 'application/pdf' })
    const url = await storage.downloadUrl(k, 'F001-123.pdf')
    expect(url).toContain('X-Amz-Expires=300')
    const res = await fetch(url)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('%PDF-1.7')
  })

  it('ping confirma que el bucket existe', async () => {
    await expect(storage.ping()).resolves.toBeUndefined()
  })
})
```

Run: `pnpm --filter @anticipate/api test:integration -- storage`
Expected: 5 tests PASS contra S3Mock; el test de `putAll` confirma que la subida que sí se hizo quedó borrada.

- [ ] **Step 5: Verificar y commit**

Run: `pnpm --filter @anticipate/api exec vitest run --project api:unit && pnpm --filter @anticipate/api test:integration && pnpm --filter @anticipate/api typecheck && pnpm lint:fix && pnpm lint`
Expected: todo en verde; `GET /health` informa `database` y `storage` como `up`.

```bash
git add apps/api pnpm-lock.yaml
git commit -m "feat(api): almacenamiento s3 con subida todo o nada, borrado seguro y enlaces firmados"
```

---

### Task 7: Pagadores: `GET /payers` y el contexto de validación

**Files:**
- Create: `apps/api/src/payers/payers.module.ts`, `apps/api/src/payers/payers.service.ts`, `apps/api/src/payers/payers.controller.ts`, `apps/api/src/invoices/validation-context.ts`
- Create: `apps/api/test/support/app.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/src/invoices/validation-context.test.ts`, `apps/api/test/integration/payers.test.ts`

**Interfaces:**
- Consumes: `PrismaService`, `decimalToAmount`, `publicPayerSchema`, `PublicPayer`, `ValidationContext`, `Currency`, `IsoDate`.
- Produces:
  - `PayersService.listPublic(): Promise<PublicPayer[]>` (solo activos, ordenados por `shortName`, cada uno validado con `publicPayerSchema`), `PayersService.findActiveBySlug(slug): Promise<PayerRecord | null>`.
  - `PayerRecord = { id: string; slug: string; ruc: string; shortName: string; advancePercent: number; minTermDays: number; maxInvoices: number; allowedCurrencies: Currency[] }`.
  - `buildValidationContext(payer: PayerRecord, supplierRuc: string, today: IsoDate): ValidationContext`.
  - `createTestApp(overrides?)`: arranca la app completa contra los contenedores con dobles para Turnstile, correo y reloj; la usan las Tareas 8 y 9.

- [ ] **Step 1: Test del contexto que falla**

`apps/api/src/invoices/validation-context.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { buildValidationContext } from './validation-context.js'

describe('buildValidationContext', () => {
  it('toma cada parámetro del pagador y el RUC que declaró el proveedor', () => {
    const ctx = buildValidationContext(
      {
        id: 'p',
        slug: 'sea',
        ruc: '20131312955',
        shortName: 'SEA',
        advancePercent: 80,
        minTermDays: 15,
        maxInvoices: 10,
        allowedCurrencies: ['PEN', 'USD'],
      },
      '20100070970',
      '2026-09-24',
    )
    expect(ctx).toEqual({
      payerRuc: '20131312955',
      payerName: 'SEA',
      supplierRuc: '20100070970',
      advancePercent: 80,
      minTermDays: 15,
      maxInvoices: 10,
      allowedCurrencies: ['PEN', 'USD'],
      today: '2026-09-24',
    })
  })

  it('rechaza un pagador con parámetros fuera de rango en vez de validar con ellos', () => {
    const payer = {
      id: 'p',
      slug: 'sea',
      ruc: '20131312955',
      shortName: 'SEA',
      advancePercent: 120,
      minTermDays: 15,
      maxInvoices: 10,
      allowedCurrencies: ['PEN'] as ('PEN' | 'USD')[],
    }
    expect(() => buildValidationContext(payer, '20100070970', '2026-09-24')).toThrow(/advancePercent/)
    expect(() => buildValidationContext({ ...payer, advancePercent: 80, allowedCurrencies: [] }, '20100070970', '2026-09-24')).toThrow(/allowedCurrencies/)
  })
})
```

Run: `pnpm --filter @anticipate/api exec vitest run --project api:unit src/invoices`
Expected: FAIL, `Cannot find module './validation-context.js'`.

- [ ] **Step 2: Implementar el contexto y el servicio de pagadores**

`apps/api/src/invoices/validation-context.ts`:
```ts
import type { IsoDate } from '@anticipate/shared/dates'
import type { ValidationContext } from '@anticipate/shared/invoice'
import type { Currency } from '@anticipate/shared/money'

export type PayerRecord = {
  id: string
  slug: string
  ruc: string
  shortName: string
  advancePercent: number
  minTermDays: number
  maxInvoices: number
  allowedCurrencies: Currency[]
}

/**
 * Contexto de las reglas de factura a partir del pagador guardado. `validateInvoices` lanza con un
 * contexto inválido por diseño (el contrato de shared es "contexto válido"), así que se valida aquí:
 * un pagador mal configurado es un error de la plataforma, no del proveedor.
 */
export function buildValidationContext(payer: PayerRecord, supplierRuc: string, today: IsoDate): ValidationContext {
  if (!(payer.advancePercent > 0 && payer.advancePercent <= 100)) {
    throw new RangeError(`Pagador ${payer.slug}: advancePercent fuera de rango (${payer.advancePercent})`)
  }
  if (!Number.isInteger(payer.minTermDays) || payer.minTermDays < 0) {
    throw new RangeError(`Pagador ${payer.slug}: minTermDays inválido (${payer.minTermDays})`)
  }
  if (!Number.isInteger(payer.maxInvoices) || payer.maxInvoices < 1) {
    throw new RangeError(`Pagador ${payer.slug}: maxInvoices inválido (${payer.maxInvoices})`)
  }
  if (payer.allowedCurrencies.length === 0) {
    throw new RangeError(`Pagador ${payer.slug}: allowedCurrencies vacío`)
  }
  return {
    payerRuc: payer.ruc,
    payerName: payer.shortName,
    supplierRuc,
    advancePercent: payer.advancePercent,
    minTermDays: payer.minTermDays,
    maxInvoices: payer.maxInvoices,
    allowedCurrencies: [...payer.allowedCurrencies],
    today,
  }
}
```

`apps/api/src/payers/payers.service.ts`:
```ts
import { type PublicPayer, publicPayerSchema } from '@anticipate/shared/payer'
import { Injectable } from '@nestjs/common'
import type { PayerRecord } from '../invoices/validation-context.js'
import { PrismaService } from '../prisma/prisma.service.js'

@Injectable()
export class PayersService {
  constructor(private readonly prisma: PrismaService) {}

  /** Lo que la landing necesita para construirse. Cada fila se valida con el contrato público de shared. */
  async listPublic(): Promise<PublicPayer[]> {
    const payers = await this.prisma.payer.findMany({ where: { active: true }, orderBy: { shortName: 'asc' } })
    return payers.map((p) =>
      publicPayerSchema.parse({
        slug: p.slug,
        ruc: p.ruc,
        legalName: p.legalName,
        shortName: p.shortName,
        advancePercent: Number(p.advancePercent.toFixed(2)),
        minTermDays: p.minTermDays,
        maxInvoices: p.maxInvoices,
        allowedCurrencies: p.allowedCurrencies,
        accentColor: p.accentColor,
        logoUrl: p.logoUrl,
        texts: p.texts,
      }),
    )
  }

  async findActiveBySlug(slug: string): Promise<PayerRecord | null> {
    const p = await this.prisma.payer.findFirst({ where: { slug, active: true } })
    if (!p) return null
    return {
      id: p.id,
      slug: p.slug,
      ruc: p.ruc,
      shortName: p.shortName,
      advancePercent: Number(p.advancePercent.toFixed(2)),
      minTermDays: p.minTermDays,
      maxInvoices: p.maxInvoices,
      allowedCurrencies: p.allowedCurrencies,
    }
  }
}
```

`apps/api/src/payers/payers.controller.ts`:
```ts
import { publicPayerSchema } from '@anticipate/shared/payer'
import { Controller, Get, Header } from '@nestjs/common'
import { ApiOkResponse } from '@nestjs/swagger'
import { z } from 'zod'
import { PayersService } from './payers.service.js'

@Controller('payers')
export class PayersController {
  constructor(private readonly payers: PayersService) {}

  @Get()
  @Header('cache-control', 'public, max-age=60')
  @ApiOkResponse({ standardSchema: z.array(publicPayerSchema) })
  list() {
    return this.payers.listPublic()
  }
}
```
(Si `@ApiOkResponse({ standardSchema })` no existe en la versión instalada de `@nestjs/swagger`, quitar el decorador y anotarlo: la documentación OpenAPI se completa en el paso 4, cuando el admin la consuma.)

`apps/api/src/payers/payers.module.ts`:
```ts
import { Module } from '@nestjs/common'
import { PayersController } from './payers.controller.js'
import { PayersService } from './payers.service.js'

@Module({ controllers: [PayersController], providers: [PayersService], exports: [PayersService] })
export class PayersModule {}
```

Agregar `PayersModule` a `AppModule.register`.

- [ ] **Step 3: La app de pruebas**

`apps/api/test/support/app.ts`:
```ts
import type { Type } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { configureApp, NEST_APP_OPTIONS } from '../../src/app.js'
import { AppModule } from '../../src/app.module.js'
import { CLOCK, type Clock } from '../../src/config/clock.js'
import { testConfig } from './config.js'

export type TestAppOptions = {
  env?: Record<string, string | undefined>
  now?: Date
  /** Reloj propio, para tests que avanzan el tiempo. Por defecto, fijo en `now` o `TEST_NOW`. */
  clock?: Clock
  extraModules?: Type[]
  /** Pares [token, instancia] para reemplazar proveedores (Turnstile, envío de correo…). */
  overrides?: ReadonlyArray<readonly [unknown, unknown]>
}

export const TEST_NOW = new Date('2026-09-24T15:00:00Z')

/**
 * App completa contra los contenedores locales, con reloj fijo y los dobles que pida cada test. Usa la
 * misma `configureApp` que producción; solo cambia cómo se arma el módulo (para poder reemplazar).
 */
export async function createTestApp(options: TestAppOptions = {}) {
  const config = testConfig(options.env)
  const clock: Clock = options.clock ?? { now: () => options.now ?? TEST_NOW }
  let builder = Test.createTestingModule({ imports: [AppModule.register(config, options.extraModules ?? [])] })
  for (const [token, value] of [[CLOCK, clock] as const, ...(options.overrides ?? [])]) {
    builder = builder.overrideProvider(token as never).useValue(value)
  }
  const moduleRef = await builder.compile()
  const app = moduleRef.createNestApplication<NestExpressApplication>(NEST_APP_OPTIONS)
  configureApp(app, config)
  await app.init()
  return app
}
```

- [ ] **Step 4: Test de integración que falla**

`apps/api/test/integration/payers.test.ts`:
```ts
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestApp } from '../support/app.js'
import { createTestPrisma, truncateAll } from '../support/db.js'
import { createPayer } from '../support/factories.js'

const db = createTestPrisma()
let app: Awaited<ReturnType<typeof createTestApp>>

beforeAll(async () => {
  app = await createTestApp()
})
beforeEach(async () => {
  await truncateAll(db.prisma)
})
afterAll(async () => {
  await app.close()
  await db.close()
})

describe('GET /payers', () => {
  it('devuelve solo los pagadores activos con sus campos públicos', async () => {
    await createPayer(db.prisma)
    await createPayer(db.prisma, { slug: 'otro', ruc: '20100070970', shortName: 'Otro', active: false })

    const res = await request(app.getHttpServer()).get('/payers').expect(200)
    expect(res.headers['cache-control']).toBe('public, max-age=60')
    expect(res.body).toEqual([
      {
        slug: 'sea',
        ruc: '20131312955',
        legalName: 'Servicios Energéticos Ambientales S.A.',
        shortName: 'SEA',
        advancePercent: 80,
        minTermDays: 15,
        maxInvoices: 10,
        allowedCurrencies: ['PEN', 'USD'],
        accentColor: '#0E7C86',
        logoUrl: null,
        texts: { title: 'Adelanta tus facturas a SEA' },
      },
    ])
  })

  it('no expone campos internos', async () => {
    await createPayer(db.prisma)
    const res = await request(app.getHttpServer()).get('/payers').expect(200)
    for (const internal of ['id', 'active', 'createdAt', 'updatedAt']) {
      expect(res.body[0]).not.toHaveProperty(internal)
    }
  })

  it('responde lista vacía sin pagadores activos', async () => {
    await request(app.getHttpServer()).get('/payers').expect(200, [])
  })
})
```

Run: `pnpm --filter @anticipate/api test:integration -- payers`
Expected: 3 tests PASS.

- [ ] **Step 5: Verificar y commit**

Run: `pnpm --filter @anticipate/api exec vitest run --project api:unit && pnpm --filter @anticipate/api test:integration && pnpm --filter @anticipate/api typecheck && pnpm lint:fix && pnpm lint`
Expected: todo en verde.

```bash
git add apps/api
git commit -m "feat(api): lista pública de pagadores y contexto de validación desde la base"
```

---

### Task 8: Notificaciones: outbox transaccional, envío por SMTP, Brevo o en memoria, y poller

**Files:**
- Create: `apps/api/src/notifications/mail/mail-sender.ts`, `apps/api/src/notifications/mail/smtp-mail-sender.ts`, `apps/api/src/notifications/mail/brevo-mail-sender.ts`, `apps/api/src/notifications/mail/fake-mail-sender.ts`
- Create: `apps/api/src/notifications/retry-delay.ts`, `apps/api/src/notifications/outbox.service.ts`, `apps/api/src/notifications/outbox-dispatcher.ts`, `apps/api/src/notifications/outbox-processor.ts`, `apps/api/src/notifications/notifications.module.ts`
- Create: `apps/api/src/notifications/outbox-poller.ts`, `apps/api/src/notifications/outbox-poller.module.ts`
- Create: `apps/api/test/support/mailpit.ts`
- Modify: `apps/api/package.json` (`nodemailer`), `apps/api/src/app.module.ts`
- Test: `apps/api/src/notifications/retry-delay.test.ts`, `apps/api/src/notifications/mail/brevo-mail-sender.test.ts`, `apps/api/test/integration/outbox.test.ts`, `apps/api/test/integration/smtp-mail.test.ts`

**Interfaces:**
- Consumes: `PrismaService`, `Tx`, `CLOCK`, `APP_CONFIG`, `decimalToAmount`, `advanceRequestCreatedEventSchema`, `DomainEvent`, `renderAdvanceRequestConfirmation`, `renderNewAdvanceRequestAlert`.
- Produces:
  - `MAIL_SENDER`, `MailSender = { send(mail: OutgoingMail): Promise<{ providerMessageId: string | null }> }`, `OutgoingMail = { to: { email: string; name?: string }; subject: string; html: string; text: string; idempotencyKey: string }`, `RetryableSendError(message, retryAfterSeconds?)`, `PermanentSendError`, `FakeMailSender` (con `sent: OutgoingMail[]` y `failNext(error, times = 1)`).
  - `OutboxService.enqueue(tx, { advanceRequestId, notification, event })`, `claim(workerId)`, `markSent(id, providerMessageId)`, `markFailed(event, error)`, `expireExhausted()`.
  - `OutboxProcessor.drain(maxBatches = 10): Promise<{ sent: number; failed: number }>`: la usan los tests y el poller.
  - `retryDelayMs(attempts, { baseDelayMs, maxDelayMs }, jitter)`.

**Diseño verificado (D29).** Una fila de `outbox_events` por correo: la confirmación al proveedor y el aviso al equipo son dos filas con el mismo evento de dominio `advance-request.created` de `shared` como `payload`. `enqueue` recibe siempre el `tx` del caso de uso, así el correo existe si y solo si la solicitud existe. `claim` es UNA sentencia `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING`, sin transacción interactiva abierta durante el envío: fija un arriendo (`locked_until`) y sube `attempts`. El envío ocurre fuera de toda transacción. `markSent` y `markFailed` filtran por `status = PROCESSING` para no pisar a otro proceso que retomó la fila tras un arriendo vencido. Todo el tiempo sale del reloj inyectable, así los tests son deterministas. La clave de idempotencia de Brevo es el id de la fila (UUID), dentro de `headers` del cuerpo JSON.

- [ ] **Step 1: Dependencia**

Agregar a `dependencies` de `apps/api/package.json`: `"nodemailer": "catalog:"`. Run: `pnpm install`.

- [ ] **Step 2: Tests unitarios que fallan**

`apps/api/src/notifications/retry-delay.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { retryDelayMs } from './retry-delay.js'

const options = { baseDelayMs: 30_000, maxDelayMs: 3_600_000 }

describe('retryDelayMs', () => {
  it('duplica la espera en cada intento hasta el tope', () => {
    expect([1, 2, 3, 4, 8, 9].map((a) => retryDelayMs(a, options, 0))).toEqual([
      30_000, 60_000, 120_000, 240_000, 3_600_000, 3_600_000,
    ])
  })

  it('aplica un jitter de ±10 %', () => {
    expect(retryDelayMs(2, options, 1)).toBe(66_000)
    expect(retryDelayMs(2, options, -1)).toBe(54_000)
  })

  it('rechaza intentos o jitter fuera de rango', () => {
    expect(() => retryDelayMs(0, options, 0)).toThrow(RangeError)
    expect(() => retryDelayMs(1, options, 2)).toThrow(RangeError)
  })
})
```

`apps/api/src/notifications/mail/brevo-mail-sender.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrevoMailSender } from './brevo-mail-sender.js'
import { PermanentSendError, RetryableSendError } from './mail-sender.js'

const mail = {
  to: { email: 'ana@proveedor.pe', name: 'Ana Pérez' },
  subject: 'Recibimos tu solicitud ANT-2026-000001',
  html: '<p>hola</p>',
  text: 'hola',
  idempotencyKey: '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b',
}
const sender = new BrevoMailSender({ apiKey: 'xkeysib-test', fromEmail: 'no-reply@anticipate.pe', fromName: 'Anticipate' })
const respond = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers }))

afterEach(() => vi.unstubAllGlobals())

describe('BrevoMailSender', () => {
  it('envía con la clave de idempotencia dentro del cuerpo y devuelve el messageId', async () => {
    const fetchMock = respond(201, { messageId: '<abc@smtp-relay.brevo.com>' })
    vi.stubGlobal('fetch', fetchMock)
    await expect(sender.send(mail)).resolves.toEqual({ providerMessageId: '<abc@smtp-relay.brevo.com>' })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.brevo.com/v3/smtp/email')
    expect((init.headers as Record<string, string>)['api-key']).toBe('xkeysib-test')
    expect(JSON.parse(init.body as string)).toMatchObject({
      sender: { email: 'no-reply@anticipate.pe', name: 'Anticipate' },
      to: [{ email: 'ana@proveedor.pe', name: 'Ana Pérez' }],
      subject: mail.subject,
      htmlContent: '<p>hola</p>',
      textContent: 'hola',
      headers: { idempotencyKey: mail.idempotencyKey },
    })
  })

  it('429 es reintentable y respeta la espera que pide Brevo', async () => {
    vi.stubGlobal('fetch', respond(429, { code: 'too_many_requests', message: 'x' }, { 'x-sib-ratelimit-reset': '42' }))
    const error = await sender.send(mail).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RetryableSendError)
    expect((error as RetryableSendError).retryAfterSeconds).toBe(42)
  })

  it('5xx y errores de red son reintentables', async () => {
    vi.stubGlobal('fetch', respond(502, {}))
    await expect(sender.send(mail)).rejects.toBeInstanceOf(RetryableSendError)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    await expect(sender.send(mail)).rejects.toBeInstanceOf(RetryableSendError)
  })

  it('otros 4xx son permanentes (no se reintenta un correo inválido)', async () => {
    vi.stubGlobal('fetch', respond(400, { code: 'invalid_parameter', message: 'email is not valid' }))
    await expect(sender.send(mail)).rejects.toBeInstanceOf(PermanentSendError)
  })
})
```

Run: `pnpm --filter @anticipate/api exec vitest run --project api:unit src/notifications`
Expected: FAIL por módulos inexistentes.

- [ ] **Step 3: Implementar el puerto de envío y sus tres implementaciones**

`apps/api/src/notifications/mail/mail-sender.ts`:
```ts
export type OutgoingMail = {
  to: { email: string; name?: string }
  subject: string
  html: string
  text: string
  /** Id de la fila del outbox: el proveedor de correo lo usa para no enviar dos veces. */
  idempotencyKey: string
}

export interface MailSender {
  send(mail: OutgoingMail): Promise<{ providerMessageId: string | null }>
}

export const MAIL_SENDER = Symbol('MAIL_SENDER')

/** El envío puede funcionar más tarde (red, 429, 5xx). */
export class RetryableSendError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'RetryableSendError'
  }
}

/** Reintentar no va a cambiar nada (dirección inválida, credenciales, solicitud inexistente). */
export class PermanentSendError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermanentSendError'
  }
}
```

`apps/api/src/notifications/mail/brevo-mail-sender.ts`:
```ts
import { z } from 'zod'
import { type MailSender, type OutgoingMail, PermanentSendError, RetryableSendError } from './mail-sender.js'

const accepted = z.object({ messageId: z.string() })
const BREVO_URL = 'https://api.brevo.com/v3/smtp/email'

export class BrevoMailSender implements MailSender {
  constructor(private readonly options: { apiKey: string; fromEmail: string; fromName: string }) {}

  async send(mail: OutgoingMail) {
    let response: Response
    try {
      response = await fetch(BREVO_URL, {
        method: 'POST',
        headers: { 'api-key': this.options.apiKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          sender: { email: this.options.fromEmail, name: this.options.fromName },
          to: [mail.to.name ? { email: mail.to.email, name: mail.to.name } : { email: mail.to.email }],
          subject: mail.subject,
          htmlContent: mail.html,
          textContent: mail.text,
          headers: { idempotencyKey: mail.idempotencyKey },
        }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch (error) {
      throw new RetryableSendError(`Brevo sin respuesta: ${error instanceof Error ? error.message : String(error)}`)
    }
    const body = await response.text()
    if (response.status === 201 || response.status === 202) {
      const parsed = accepted.safeParse(JSON.parse(body || '{}'))
      return { providerMessageId: parsed.success ? parsed.data.messageId : null }
    }
    if (response.status === 429) {
      const reset = Number(response.headers.get('x-sib-ratelimit-reset'))
      throw new RetryableSendError(`Brevo 429: ${body}`, Number.isFinite(reset) && reset > 0 ? reset : undefined)
    }
    if (response.status >= 500) throw new RetryableSendError(`Brevo ${response.status}: ${body}`)
    throw new PermanentSendError(`Brevo ${response.status}: ${body}`)
  }
}
```

`apps/api/src/notifications/mail/smtp-mail-sender.ts`:
```ts
import { createTransport, type Transporter } from 'nodemailer'
import { type MailSender, type OutgoingMail, PermanentSendError, RetryableSendError } from './mail-sender.js'

/** SMTP hacia Mailpit en desarrollo: ningún correo de prueba le llega a una persona real. */
export class SmtpMailSender implements MailSender {
  private readonly transporter: Transporter

  constructor(private readonly options: { host: string; port: number; fromEmail: string; fromName: string }) {
    this.transporter = createTransport({ host: options.host, port: options.port, secure: false, ignoreTLS: true })
  }

  async send(mail: OutgoingMail) {
    try {
      const info = await this.transporter.sendMail({
        from: { name: this.options.fromName, address: this.options.fromEmail },
        to: mail.to.name ? { name: mail.to.name, address: mail.to.email } : mail.to.email,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        headers: { 'X-Idempotency-Key': mail.idempotencyKey },
      })
      return { providerMessageId: info.messageId ?? null }
    } catch (error) {
      const code = (error as { responseCode?: number }).responseCode
      const message = error instanceof Error ? error.message : String(error)
      if (code !== undefined && code >= 500 && code < 600) throw new PermanentSendError(`SMTP ${code}: ${message}`)
      throw new RetryableSendError(`SMTP: ${message}`)
    }
  }

  close() {
    this.transporter.close()
  }
}
```

`apps/api/src/notifications/mail/fake-mail-sender.ts`:
```ts
import type { MailSender, OutgoingMail } from './mail-sender.js'

/** Envío en memoria: para tests y para desarrollar sin Mailpit (MAIL_TRANSPORT=fake). */
export class FakeMailSender implements MailSender {
  readonly sent: OutgoingMail[] = []
  private failures: Error[] = []

  failNext(error: Error, times = 1) {
    for (let i = 0; i < times; i++) this.failures.push(error)
  }

  async send(mail: OutgoingMail) {
    const failure = this.failures.shift()
    if (failure) throw failure
    this.sent.push(mail)
    return { providerMessageId: `fake-${this.sent.length}` }
  }

  reset() {
    this.sent.length = 0
    this.failures = []
  }
}
```

`apps/api/src/notifications/retry-delay.ts`:
```ts
/**
 * Espera antes del siguiente intento: base × 2^(intentos − 1), con tope, más un jitter de ±10 %
 * para no sincronizar reintentos. `jitter` va de −1 a 1 (en producción, `Math.random() * 2 − 1`).
 */
export function retryDelayMs(
  attempts: number,
  options: { baseDelayMs: number; maxDelayMs: number },
  jitter: number,
): number {
  if (!Number.isInteger(attempts) || attempts < 1) throw new RangeError(`Intentos inválidos: ${attempts}`)
  if (!(jitter >= -1 && jitter <= 1)) throw new RangeError(`Jitter fuera de rango: ${jitter}`)
  const raw = Math.min(options.baseDelayMs * 2 ** (attempts - 1), options.maxDelayMs)
  return Math.round(raw + raw * 0.1 * jitter)
}
```

Run: `pnpm --filter @anticipate/api exec vitest run --project api:unit src/notifications`
Expected: los 7 tests PASS.

- [ ] **Step 4: Tests de integración del outbox que fallan**

`apps/api/test/support/mailpit.ts`:
```ts
const MAILPIT = process.env.MAILPIT_API_URL ?? 'http://127.0.0.1:8025'

export type MailpitMessage = { ID: string; Subject: string; To: { Address: string }[] }

export async function clearMailbox() {
  const res = await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`Mailpit DELETE ${res.status}`)
}

export async function findMailsTo(email: string): Promise<MailpitMessage[]> {
  const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
  return ((await res.json()) as { messages: MailpitMessage[] }).messages
}

export async function readMail(id: string): Promise<{ Subject: string; HTML: string; Text: string }> {
  return (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()
}
```

`apps/api/test/integration/smtp-mail.test.ts`:
```ts
import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { SmtpMailSender } from '../../src/notifications/mail/smtp-mail-sender.js'
import { clearMailbox, findMailsTo, readMail } from '../support/mailpit.js'

describe('SmtpMailSender contra Mailpit', () => {
  beforeEach(clearMailbox)

  it('el correo llega con asunto, HTML y texto', async () => {
    const sender = new SmtpMailSender({
      host: process.env.SMTP_HOST ?? '127.0.0.1',
      port: Number(process.env.SMTP_PORT ?? 1025),
      fromEmail: 'solicitudes@anticipate.local',
      fromName: 'Anticipate',
    })
    await sender.send({
      to: { email: 'ana@proveedor.pe', name: 'Ana Pérez' },
      subject: 'Recibimos tu solicitud ANT-2026-000001',
      html: '<p>Hola, Ana</p>',
      text: 'Hola, Ana',
      idempotencyKey: randomUUID(),
    })
    sender.close()
    const [message] = await findMailsTo('ana@proveedor.pe')
    expect(message?.Subject).toBe('Recibimos tu solicitud ANT-2026-000001')
    const full = await readMail(message?.ID ?? '')
    expect(full.HTML).toContain('Hola, Ana')
    expect(full.Text).toContain('Hola, Ana')
  })
})
```

`apps/api/test/integration/outbox.test.ts`:
```ts
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeMailSender } from '../../src/notifications/mail/fake-mail-sender.js'
import { MAIL_SENDER, PermanentSendError, RetryableSendError } from '../../src/notifications/mail/mail-sender.js'
import { OutboxProcessor } from '../../src/notifications/outbox-processor.js'
import { OutboxService } from '../../src/notifications/outbox.service.js'
import { PrismaService } from '../../src/prisma/prisma.service.js'
import { createTestApp } from '../support/app.js'
import { createTestPrisma, truncateAll } from '../support/db.js'
import { createAdvanceRequest, createPayer, createSupplier } from '../support/factories.js'

const now = new Date('2026-09-24T15:00:00Z')
let clockNow = now
const mailer = new FakeMailSender()
const db = createTestPrisma()
let app: Awaited<ReturnType<typeof createTestApp>>
let outbox: OutboxService
let processor: OutboxProcessor
let prisma: PrismaService

const createdEvent = (advanceRequestId: string, publicCode: string) => ({
  id: randomUUID(),
  occurredAt: now.toISOString(),
  version: 1 as const,
  type: 'advance-request.created' as const,
  payload: {
    advanceRequestId,
    publicCode,
    payerSlug: 'sea',
    supplierRuc: '20100070970',
    currency: 'PEN' as const,
    requestedAmount: '8000.00',
    invoiceCount: 1,
    contactEmail: 'ana@proveedor.pe',
  },
})

async function seedRequest() {
  const payer = await createPayer(db.prisma)
  const supplier = await createSupplier(db.prisma)
  return createAdvanceRequest(db.prisma, payer.id, supplier.id)
}

async function enqueueBoth(requestId: string, publicCode: string) {
  await prisma.$transaction(async (tx) => {
    const event = createdEvent(requestId, publicCode)
    await outbox.enqueue(tx, { advanceRequestId: requestId, notification: 'SUPPLIER_CONFIRMATION', event })
    await outbox.enqueue(tx, { advanceRequestId: requestId, notification: 'TEAM_ALERT', event })
  })
}

beforeAll(async () => {
  app = await createTestApp({ clock: { now: () => clockNow }, overrides: [[MAIL_SENDER, mailer]] })
  outbox = app.get(OutboxService)
  processor = app.get(OutboxProcessor)
  prisma = app.get(PrismaService)
})
beforeEach(async () => {
  await truncateAll(db.prisma)
  mailer.reset()
  clockNow = now
})
afterAll(async () => {
  await app.close()
  await db.close()
})

describe('outbox', () => {
  it('si la transacción se revierte, no queda ningún correo pendiente', async () => {
    const request = await seedRequest()
    await expect(
      prisma.$transaction(async (tx) => {
        await outbox.enqueue(tx, {
          advanceRequestId: request.id,
          notification: 'SUPPLIER_CONFIRMATION',
          event: createdEvent(request.id, request.publicCode),
        })
        throw new Error('falla después de encolar')
      }),
    ).rejects.toThrow('falla después de encolar')
    expect(await db.prisma.outboxEvent.count()).toBe(0)
  })

  it('drain envía la confirmación al proveedor y el aviso al equipo, una sola vez', async () => {
    const request = await seedRequest()
    await enqueueBoth(request.id, request.publicCode)

    await expect(processor.drain()).resolves.toEqual({ sent: 2, failed: 0 })
    const byRecipient = Object.fromEntries(mailer.sent.map((m) => [m.to.email, m]))
    expect(byRecipient['ana@proveedor.pe']?.subject).toBe(`Recibimos tu solicitud ${request.publicCode}`)
    expect(byRecipient['equipo@anticipate.local']?.subject).toBe(`Nueva solicitud ${request.publicCode} · SEA`)
    expect(byRecipient['equipo@anticipate.local']?.html).toContain(`http://localhost:3000/advance-requests/${request.id}`)

    const rows = await db.prisma.outboxEvent.findMany()
    expect(rows.map((r) => r.status)).toEqual(['SENT', 'SENT'])
    expect(new Set(mailer.sent.map((m) => m.idempotencyKey))).toEqual(new Set(rows.map((r) => r.id)))

    await expect(processor.drain()).resolves.toEqual({ sent: 0, failed: 0 })
    expect(mailer.sent).toHaveLength(2)
  })

  it('un fallo reintentable vuelve a PENDING con espera exponencial', async () => {
    const request = await seedRequest()
    await enqueueBoth(request.id, request.publicCode)
    mailer.failNext(new RetryableSendError('Brevo 502'), 2)

    await expect(processor.drain()).resolves.toEqual({ sent: 0, failed: 2 })
    const rows = await db.prisma.outboxEvent.findMany()
    for (const row of rows) {
      expect(row.status).toBe('PENDING')
      expect(row.attempts).toBe(1)
      expect(row.lastError).toContain('Brevo 502')
      const waited = row.nextAttemptAt.getTime() - now.getTime()
      expect(waited).toBeGreaterThanOrEqual(27_000)
      expect(waited).toBeLessThanOrEqual(33_000)
    }
    // Antes de que venza la espera, no se reintenta.
    await expect(processor.drain()).resolves.toEqual({ sent: 0, failed: 0 })
    // Cuando vence, se envía.
    clockNow = new Date(now.getTime() + 60_000)
    await expect(processor.drain()).resolves.toEqual({ sent: 2, failed: 0 })
  })

  it('un fallo permanente queda FAILED sin agotar reintentos', async () => {
    const request = await seedRequest()
    await enqueueBoth(request.id, request.publicCode)
    mailer.failNext(new PermanentSendError('Brevo 400: email is not valid'), 2)
    await processor.drain()
    const rows = await db.prisma.outboxEvent.findMany()
    expect(rows.map((r) => [r.status, r.attempts])).toEqual([
      ['FAILED', 1],
      ['FAILED', 1],
    ])
  })

  it('tras el máximo de intentos queda FAILED', async () => {
    const request = await seedRequest()
    await enqueueBoth(request.id, request.publicCode)
    await db.prisma.outboxEvent.updateMany({ data: { maxAttempts: 2 } })
    mailer.failNext(new RetryableSendError('red'), 4)

    await processor.drain()
    clockNow = new Date(now.getTime() + 10 * 60_000)
    await processor.drain()
    const rows = await db.prisma.outboxEvent.findMany()
    expect(rows.map((r) => [r.status, r.attempts])).toEqual([
      ['FAILED', 2],
      ['FAILED', 2],
    ])
  })

  it('una fila en PROCESSING con el arriendo vencido se retoma; una SENT nunca', async () => {
    const request = await seedRequest()
    await enqueueBoth(request.id, request.publicCode)
    const [first, second] = await db.prisma.outboxEvent.findMany({ orderBy: { notification: 'asc' } })
    // La primera quedó colgada en otra instancia que se cayó hace 10 minutos.
    await db.prisma.outboxEvent.update({
      where: { id: first?.id ?? '' },
      data: { status: 'PROCESSING', attempts: 1, lockedUntil: new Date(now.getTime() - 60_000), lockedBy: 'otra:1' },
    })
    await db.prisma.outboxEvent.update({ where: { id: second?.id ?? '' }, data: { status: 'SENT', sentAt: now } })

    await expect(processor.drain()).resolves.toEqual({ sent: 1, failed: 0 })
    expect(mailer.sent.map((m) => m.idempotencyKey)).toEqual([first?.id])
  })

  it('dos procesos que reclaman a la vez nunca toman la misma fila', async () => {
    const request = await seedRequest()
    for (let i = 0; i < 10; i++) await enqueueBoth(request.id, request.publicCode)
    const [a, b] = await Promise.all([outbox.claim('proceso-a'), outbox.claim('proceso-b')])
    const ids = [...a, ...b].map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBe(20)
  })
})
```
En el test de concurrencia, con `OUTBOX_BATCH_SIZE` en 20, un proceso puede tomar las 20 filas y el otro ninguna: lo que se afirma es que entre los dos suman 20 y no hay repetidas.

Run: `pnpm --filter @anticipate/api test:integration -- outbox smtp-mail`
Expected: FAIL por módulos inexistentes (el de SMTP ya pasa).

- [ ] **Step 5: Implementar el servicio, el dispatcher y el procesador**

`apps/api/src/notifications/outbox.service.ts`:
```ts
import type { DomainEvent } from '@anticipate/shared/advance-request'
import { Inject, Injectable } from '@nestjs/common'
import type { AppConfig } from '../config/app-config.js'
import { CLOCK, type Clock } from '../config/clock.js'
import { APP_CONFIG } from '../config/config.module.js'
import type { OutboxNotification, Prisma } from '../generated/prisma/client.js'
import { PrismaService, type Tx } from '../prisma/prisma.service.js'
import { PermanentSendError, RetryableSendError } from './mail/mail-sender.js'
import { retryDelayMs } from './retry-delay.js'

export type ClaimedOutboxEvent = {
  id: string
  advanceRequestId: string
  notification: OutboxNotification
  payload: unknown
  attempts: number
  maxAttempts: number
}

@Injectable()
export class OutboxService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Siempre con el `tx` del caso de uso: el correo se confirma o se revierte junto con la solicitud. */
  enqueue(tx: Tx, input: { advanceRequestId: string; notification: OutboxNotification; event: DomainEvent }) {
    return tx.outboxEvent.create({
      data: {
        advanceRequestId: input.advanceRequestId,
        notification: input.notification,
        eventType: input.event.type,
        payload: input.event as unknown as Prisma.InputJsonValue,
        maxAttempts: this.config.outbox.maxAttempts,
        nextAttemptAt: this.clock.now(),
      },
    })
  }

  /**
   * Reclama un lote en UNA sentencia atómica: SKIP LOCKED evita que dos procesos tomen la misma fila
   * y el arriendo cubre la caída de un proceso entre reclamar y marcar. No retiene conexión al enviar.
   */
  claim(workerId: string): Promise<ClaimedOutboxEvent[]> {
    const now = this.clock.now()
    const { batchSize, leaseSeconds } = this.config.outbox
    const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000)
    return this.prisma.$queryRaw<ClaimedOutboxEvent[]>`
      UPDATE outbox_events AS o
      SET status = 'PROCESSING',
          attempts = o.attempts + 1,
          locked_until = ${leaseUntil}::timestamptz,
          locked_by = ${workerId}::text
      WHERE o.id IN (
        SELECT id FROM outbox_events
        WHERE attempts < max_attempts
          AND (
            (status = 'PENDING' AND next_attempt_at <= ${now}::timestamptz)
            OR (status = 'PROCESSING' AND locked_until < ${now}::timestamptz)
          )
        ORDER BY next_attempt_at
        LIMIT ${batchSize}::int
        FOR UPDATE SKIP LOCKED
      )
      RETURNING o.id,
                o.advance_request_id AS "advanceRequestId",
                o.notification::text AS notification,
                o.payload,
                o.attempts,
                o.max_attempts AS "maxAttempts"`
  }

  /** Filas colgadas con el arriendo vencido y sin intentos restantes: quedan FAILED y visibles en el admin. */
  expireExhausted() {
    const now = this.clock.now()
    return this.prisma.$executeRaw`
      UPDATE outbox_events
      SET status = 'FAILED',
          locked_until = NULL,
          locked_by = NULL,
          last_error = left(coalesce(last_error, '') || ' | arriendo vencido sin intentos restantes', 2000)
      WHERE status = 'PROCESSING' AND locked_until < ${now}::timestamptz AND attempts >= max_attempts`
  }

  markSent(id: string, providerMessageId: string | null) {
    return this.prisma.outboxEvent.updateMany({
      where: { id, status: 'PROCESSING' },
      data: { status: 'SENT', sentAt: this.clock.now(), providerMessageId, lockedUntil: null, lockedBy: null },
    })
  }

  markFailed(event: ClaimedOutboxEvent, error: unknown) {
    const permanent = error instanceof PermanentSendError
    const exhausted = event.attempts >= event.maxAttempts
    const lastError = (error instanceof Error ? error.message : String(error)).slice(0, 2000)
    if (permanent || exhausted) {
      return this.prisma.outboxEvent.updateMany({
        where: { id: event.id, status: 'PROCESSING' },
        data: { status: 'FAILED', lastError, lockedUntil: null, lockedBy: null },
      })
    }
    const backoff = retryDelayMs(event.attempts, this.config.outbox, Math.random() * 2 - 1)
    const requested = error instanceof RetryableSendError && error.retryAfterSeconds ? error.retryAfterSeconds * 1000 : 0
    return this.prisma.outboxEvent.updateMany({
      where: { id: event.id, status: 'PROCESSING' },
      data: {
        status: 'PENDING',
        lastError,
        nextAttemptAt: new Date(this.clock.now().getTime() + Math.max(backoff, requested)),
        lockedUntil: null,
        lockedBy: null,
      },
    })
  }
}
```

`apps/api/src/notifications/outbox-dispatcher.ts`:
```ts
import { renderAdvanceRequestConfirmation, renderNewAdvanceRequestAlert } from '@anticipate/emails'
import { advanceRequestCreatedEventSchema } from '@anticipate/shared/advance-request'
import { Inject, Injectable } from '@nestjs/common'
import type { AppConfig } from '../config/app-config.js'
import { APP_CONFIG } from '../config/config.module.js'
import { decimalToAmount } from '../prisma/db-values.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { MAIL_SENDER, type MailSender, PermanentSendError } from './mail/mail-sender.js'
import type { ClaimedOutboxEvent } from './outbox.service.js'

/** Traduce una fila del outbox a un correo y lo envía. Lee los nombres de la base al momento de enviar. */
@Injectable()
export class OutboxDispatcher {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(MAIL_SENDER) private readonly mailer: MailSender,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async dispatch(event: ClaimedOutboxEvent) {
    const parsed = advanceRequestCreatedEventSchema.safeParse(event.payload)
    if (!parsed.success) throw new PermanentSendError(`Evento de outbox inválido: ${parsed.error.message}`)
    const request = await this.prisma.advanceRequest.findUnique({
      where: { id: event.advanceRequestId },
      include: { payer: true, supplier: true },
    })
    if (!request) throw new PermanentSendError(`La solicitud ${event.advanceRequestId} no existe`)

    const common = {
      publicCode: request.publicCode,
      payerName: request.payer.shortName,
      requestedAmount: decimalToAmount(request.requestedAmount),
      currency: request.currency,
      invoiceCount: parsed.data.payload.invoiceCount,
    }
    if (event.notification === 'SUPPLIER_CONFIRMATION') {
      const email = await renderAdvanceRequestConfirmation({ ...common, contactName: request.contactFullName })
      return this.mailer.send({
        to: { email: request.contactEmail, name: request.contactFullName },
        ...email,
        idempotencyKey: event.id,
      })
    }
    const email = await renderNewAdvanceRequestAlert({
      ...common,
      supplierName: request.supplier.legalName,
      supplierRuc: request.supplier.ruc,
      adminUrl: `${this.config.adminBaseUrl}/advance-requests/${request.id}`,
    })
    return this.mailer.send({ to: { email: this.config.teamNotificationEmail }, ...email, idempotencyKey: event.id })
  }
}
```

`apps/api/src/notifications/outbox-processor.ts`:
```ts
import { hostname } from 'node:os'
import { Injectable, Logger } from '@nestjs/common'
import { OutboxDispatcher } from './outbox-dispatcher.js'
import { OutboxService } from './outbox.service.js'

@Injectable()
export class OutboxProcessor {
  private readonly logger = new Logger(OutboxProcessor.name)
  private readonly workerId = `${hostname()}:${process.pid}`

  constructor(
    private readonly outbox: OutboxService,
    private readonly dispatcher: OutboxDispatcher,
  ) {}

  /** Procesa lotes hasta vaciar la cola o llegar a `maxBatches`. Público para tests y para el poller. */
  async drain(maxBatches = 10): Promise<{ sent: number; failed: number }> {
    let sent = 0
    let failed = 0
    await this.outbox.expireExhausted()
    for (let batch = 0; batch < maxBatches; batch++) {
      const events = await this.outbox.claim(this.workerId)
      if (events.length === 0) break
      for (const event of events) {
        try {
          const { providerMessageId } = await this.dispatcher.dispatch(event)
          await this.outbox.markSent(event.id, providerMessageId)
          sent++
        } catch (error) {
          this.logger.warn({ eventId: event.id, attempts: event.attempts, err: error }, 'envío fallido')
          await this.outbox.markFailed(event, error)
          failed++
        }
      }
    }
    return { sent, failed }
  }
}
```

`apps/api/src/notifications/notifications.module.ts`:
```ts
import { Module } from '@nestjs/common'
import type { AppConfig } from '../config/app-config.js'
import { APP_CONFIG } from '../config/config.module.js'
import { BrevoMailSender } from './mail/brevo-mail-sender.js'
import { FakeMailSender } from './mail/fake-mail-sender.js'
import { MAIL_SENDER } from './mail/mail-sender.js'
import { SmtpMailSender } from './mail/smtp-mail-sender.js'
import { OutboxDispatcher } from './outbox-dispatcher.js'
import { OutboxProcessor } from './outbox-processor.js'
import { OutboxService } from './outbox.service.js'

@Module({
  providers: [
    OutboxService,
    OutboxDispatcher,
    OutboxProcessor,
    {
      provide: MAIL_SENDER,
      inject: [APP_CONFIG],
      useFactory: ({ mail }: AppConfig) => {
        if (mail.transport === 'brevo') {
          return new BrevoMailSender({ apiKey: mail.brevoApiKey ?? '', fromEmail: mail.fromEmail, fromName: mail.fromName })
        }
        if (mail.transport === 'smtp') {
          return new SmtpMailSender({ host: mail.smtpHost ?? '', port: mail.smtpPort, fromEmail: mail.fromEmail, fromName: mail.fromName })
        }
        return new FakeMailSender()
      },
    },
  ],
  exports: [OutboxService, OutboxProcessor, MAIL_SENDER],
})
export class NotificationsModule {}
```
(La configuración ya garantiza `brevoApiKey` con `brevo` y `smtpHost` con `smtp`; el `?? ''` solo satisface al compilador.)

- [ ] **Step 6: El poller, registrado solo si la configuración lo pide**

`apps/api/src/notifications/outbox-poller.ts`:
```ts
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common'
import { SchedulerRegistry } from '@nestjs/schedule'
import type { AppConfig } from '../config/app-config.js'
import { APP_CONFIG } from '../config/config.module.js'
import { OutboxProcessor } from './outbox-processor.js'

const INTERVAL_NAME = 'outbox-poller'

/** Vacía el outbox cada `OUTBOX_POLL_INTERVAL_MS`, sin solaparse consigo mismo. */
@Injectable()
export class OutboxPoller implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxPoller.name)
  private busy = false

  constructor(
    private readonly processor: OutboxProcessor,
    private readonly scheduler: SchedulerRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap() {
    const interval = setInterval(() => void this.tick(), this.config.outbox.pollIntervalMs)
    this.scheduler.addInterval(INTERVAL_NAME, interval)
  }

  onApplicationShutdown() {
    if (this.scheduler.doesExist('interval', INTERVAL_NAME)) this.scheduler.deleteInterval(INTERVAL_NAME)
  }

  async tick() {
    if (this.busy) return
    this.busy = true
    try {
      const { sent, failed } = await this.processor.drain()
      if (sent + failed > 0) this.logger.log({ sent, failed }, 'outbox procesado')
    } catch (error) {
      this.logger.error({ err: error }, 'error al procesar el outbox')
    } finally {
      this.busy = false
    }
  }
}
```

`apps/api/src/notifications/outbox-poller.module.ts`:
```ts
import { Module } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'
import { NotificationsModule } from './notifications.module.js'
import { OutboxPoller } from './outbox-poller.js'

@Module({ imports: [ScheduleModule.forRoot(), NotificationsModule], providers: [OutboxPoller] })
export class OutboxPollerModule {}
```

En `AppModule.register`, agregar `NotificationsModule` y, después, `...(config.outbox.pollerEnabled ? [OutboxPollerModule] : [])`. En los tests la configuración trae `OUTBOX_POLLER_ENABLED=false`, así que el poller nunca corre y los tests llaman a `OutboxProcessor.drain()` directamente.

- [ ] **Step 7: Verificar**

Run: `pnpm --filter @anticipate/api test:integration -- outbox smtp-mail && pnpm --filter @anticipate/api exec vitest run --project api:unit && pnpm --filter @anticipate/api typecheck && pnpm lint:fix && pnpm lint`
Expected: 8 tests de integración y los unitarios en verde. Si PostgreSQL rechaza el tipo de algún parámetro de `claim` (por ejemplo la comparación de `status` con texto), agregar el cast explícito (`'PROCESSING'::outbox_status`) y anotarlo.

- [ ] **Step 8: Commit**

```bash
git add apps/api pnpm-lock.yaml
git commit -m "feat(api): outbox transaccional con reintentos, envío por smtp o brevo y poller"
```

---

### Task 9: `POST /advance-requests`: recepción de solicitudes de punta a punta

**Files:**
- Create: `apps/api/src/security/turnstile.verifier.ts`, `apps/api/src/security/turnstile.guard.ts`, `apps/api/src/security/security.module.ts`
- Create: `apps/api/src/common/body-limit.middleware.ts`
- Create: `apps/api/src/invoices/uploaded-files.ts`, `apps/api/src/invoices/invoice-reader.ts`
- Create: `apps/api/src/advance-requests/advance-request-form.pipe.ts`, `apps/api/src/advance-requests/advance-requests.service.ts`, `apps/api/src/advance-requests/advance-requests.controller.ts`, `apps/api/src/advance-requests/advance-requests.module.ts`
- Create: `apps/api/test/support/advance-request-fixtures.ts`, `apps/api/test/support/s3.ts`
- Modify: `apps/api/src/app.module.ts`, `apps/api/src/common/problems.filter.ts`, `apps/api/src/common/http-messages.es.ts`
- Test: `apps/api/src/invoices/uploaded-files.test.ts`, `apps/api/src/security/turnstile.verifier.test.ts`, `apps/api/test/integration/advance-requests.test.ts`

**Interfaces:**
- Consumes: todo lo anterior. De `shared`: `advanceRequestFormSchema`, `AdvanceRequestForm`, `decodeXml`, `parseUblInvoice`, `validateInvoices`, `validateRequestedAmount`, `invoiceKey`, `formatPublicCode`, `advanceRequestCreatedEventSchema`, `createProblem`, `todayIn`, `LIMA_TIME_ZONE`, `ParsedInvoice`.
- Produces: el endpoint descrito en "Contrato de `POST /advance-requests`" (al inicio del plan), y `TURNSTILE_VERIFIER` con `TurnstileVerifier.verify(token, remoteIp): Promise<boolean>`.

**Orden del flujo (STACK §8, pasos 1 a 7).** (1) límite de bytes por `Content-Length` antes de leer nada; (2) límite de envíos por IP; (3) Turnstile por cabecera, antes de que multer lea los archivos; (4) multer en memoria con topes de tamaño y cantidad; (5) el campo `form` se valida con el esquema de `shared`; (6) el pagador activo arma el contexto; (7) se leen los XML, se emparejan los PDF, se aplican las reglas y el monto, y se juntan todos los problemas en una sola respuesta 422; (8) se descartan las facturas que ya están en una solicitud viva; (9) se suben todos los archivos, todo o nada; (10) una transacción guarda proveedor, representante, solicitud, facturas, archivos, consentimientos, historial y los dos correos del outbox; si falla, se borran los archivos; (11) 201 con el código público.

- [ ] **Step 1: Tests unitarios de archivos y Turnstile que fallan**

`apps/api/src/invoices/uploaded-files.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { baseName, isPdf, pairPdfs } from './uploaded-files.js'

const MAX_PDF_BYTES = 1024
const file = (originalname: string, content = '%PDF-1.7') => ({
  originalname,
  buffer: Buffer.from(content),
  size: Buffer.byteLength(content),
})

describe('archivos subidos', () => {
  it('reconoce un PDF por su firma, no por su nombre', () => {
    expect(isPdf(Buffer.from('%PDF-1.7\n…'))).toBe(true)
    expect(isPdf(Buffer.from('<?xml version="1.0"?>'))).toBe(false)
    expect(isPdf(Buffer.alloc(0))).toBe(false)
  })

  it('el nombre base ignora extensión, mayúsculas y ruta', () => {
    expect(baseName('F001-123.XML')).toBe('f001-123')
    expect(baseName('C:\\docs\\F001-123.pdf')).toBe('f001-123')
    expect(baseName('carpeta/f001-123.Pdf')).toBe('f001-123')
  })

  it('empareja cada PDF con el XML del mismo nombre base', () => {
    const xmls = [file('F001-1.xml'), file('F001-2.xml')]
    const pdfs = [file('f001-2.PDF'), file('F001-9.pdf'), file('F001-2 (copia).pdf')]
    const { pdfByXml, problems } = pairPdfs(xmls, pdfs, MAX_PDF_BYTES)
    expect(pdfByXml.get(xmls[1] as never)?.originalname).toBe('f001-2.PDF')
    expect(pdfByXml.has(xmls[0] as never)).toBe(false)
    expect(problems.map((p) => [p.code, p.file])).toEqual([
      ['PDF_WITHOUT_XML', 'F001-9.pdf'],
      ['PDF_WITHOUT_XML', 'F001-2 (copia).pdf'],
    ])
  })

  it('un segundo PDF para el mismo XML es un problema', () => {
    const { problems } = pairPdfs([file('F001-1.xml')], [file('F001-1.pdf'), file('f001-1.PDF')], MAX_PDF_BYTES)
    expect(problems.map((p) => [p.code, p.file])).toEqual([['PDF_WITHOUT_XML', 'f001-1.PDF']])
  })

  it('un PDF que no lo es por contenido es un problema', () => {
    const { problems } = pairPdfs([file('F001-1.xml')], [file('F001-1.pdf', 'no soy un pdf')], MAX_PDF_BYTES)
    expect(problems.map((p) => p.code)).toEqual(['INVALID_PDF'])
  })

  it('un PDF mayor al tope es un problema con su nombre y el tope en MB', () => {
    const big = file('F001-1.pdf', `%PDF-1.7${' '.repeat(2 * 1024 * 1024)}`)
    const { problems } = pairPdfs([file('F001-1.xml')], [big], 1024 * 1024)
    expect(problems).toEqual([
      expect.objectContaining({ code: 'FILE_TOO_LARGE', file: 'F001-1.pdf', params: { file: 'F001-1.pdf', max: 1 } }),
    ])
  })
})
```

`apps/api/src/security/turnstile.verifier.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudflareTurnstileVerifier } from './turnstile.verifier.js'

const verifier = (expectedHostname?: string) =>
  new CloudflareTurnstileVerifier({ secretKey: '1x0000000000000000000000000000000AA', expectedHostname })
const reply = (body: unknown) => vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }))

afterEach(() => vi.unstubAllGlobals())

describe('CloudflareTurnstileVerifier', () => {
  it('acepta un token válido y envía secreto, token e IP', async () => {
    const fetchMock = reply({ success: true, hostname: 'localhost' })
    vi.stubGlobal('fetch', fetchMock)
    await expect(verifier().verify('token', '203.0.113.7')).resolves.toBe(true)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify')
    expect(JSON.parse(init.body as string)).toMatchObject({
      secret: '1x0000000000000000000000000000000AA',
      response: 'token',
      remoteip: '203.0.113.7',
    })
  })

  it('rechaza un token inválido, vacío o demasiado largo sin llamar a Cloudflare si no hace falta', async () => {
    vi.stubGlobal('fetch', reply({ success: false, 'error-codes': ['invalid-input-response'] }))
    await expect(verifier().verify('malo', '203.0.113.7')).resolves.toBe(false)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(verifier().verify('', '203.0.113.7')).resolves.toBe(false)
    await expect(verifier().verify('x'.repeat(2049), '203.0.113.7')).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('con hostname esperado, rechaza un token emitido para otro sitio', async () => {
    vi.stubGlobal('fetch', reply({ success: true, hostname: 'otro-sitio.com' }))
    await expect(verifier('anticipate.pe').verify('token', '203.0.113.7')).resolves.toBe(false)
  })

  it('si Cloudflare no responde, lanza (la API responde 503, no deja pasar)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    await expect(verifier().verify('token', '203.0.113.7')).rejects.toThrow()
  })
})
```

Run: `pnpm --filter @anticipate/api exec vitest run --project api:unit src/invoices src/security`
Expected: FAIL por módulos inexistentes.

- [ ] **Step 2: Implementar archivos, lectura de facturas y Turnstile**

`apps/api/src/invoices/uploaded-files.ts`:
```ts
import { createProblem, type Problem } from '@anticipate/shared/errors'

/** Lo que la API usa de un archivo de multer. */
export type UploadedFile = { originalname: string; buffer: Buffer; size: number }

const PDF_SIGNATURE = Buffer.from('%PDF-')
const BYTES_PER_MB = 1024 * 1024

export const isPdf = (buffer: Buffer): boolean =>
  buffer.length >= PDF_SIGNATURE.length && buffer.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE)

/** Nombre sin ruta ni extensión, en minúsculas: `C:\\docs\\F001-123.PDF` → `f001-123`. */
export const baseName = (name: string): string => {
  const last = name.split(/[\\/]/).pop() ?? name
  const dot = last.lastIndexOf('.')
  return (dot > 0 ? last.slice(0, dot) : last).trim().toLowerCase()
}

const fileProblem = (code: 'FILE_TOO_LARGE' | 'INVALID_PDF' | 'PDF_WITHOUT_XML', file: string, max?: number): Problem =>
  createProblem(code, { file, data: max === undefined ? { file } : { file, max } })

/**
 * Cada PDF (opcional) se asocia al XML con el mismo nombre base. Un PDF mayor al tope, que no es PDF
 * por contenido, sin XML o repetido para el mismo XML es un problema con el nombre del archivo.
 */
export function pairPdfs<T extends UploadedFile>(xmls: readonly T[], pdfs: readonly T[], maxPdfBytes: number) {
  const xmlByBase = new Map<string, T>()
  for (const xml of xmls) {
    const base = baseName(xml.originalname)
    if (!xmlByBase.has(base)) xmlByBase.set(base, xml)
  }
  const pdfByXml = new Map<T, T>()
  const problems: Problem[] = []
  for (const pdf of pdfs) {
    if (pdf.size > maxPdfBytes) {
      problems.push(fileProblem('FILE_TOO_LARGE', pdf.originalname, Math.floor(maxPdfBytes / BYTES_PER_MB)))
      continue
    }
    if (!isPdf(pdf.buffer)) {
      problems.push(fileProblem('INVALID_PDF', pdf.originalname))
      continue
    }
    const xml = xmlByBase.get(baseName(pdf.originalname))
    if (!xml || pdfByXml.has(xml)) {
      problems.push(fileProblem('PDF_WITHOUT_XML', pdf.originalname))
      continue
    }
    pdfByXml.set(xml, pdf)
  }
  return { pdfByXml, problems }
}
```

`apps/api/src/invoices/invoice-reader.ts`:
```ts
import { createProblem, type Problem } from '@anticipate/shared/errors'
import { decodeXml, type ParsedInvoice, parseUblInvoice } from '@anticipate/shared/invoice'
import type { UploadedFile } from './uploaded-files.js'

export type ReadInvoice<T extends UploadedFile> = { file: T; invoice: ParsedInvoice }

/**
 * Lee cada XML con el lector de shared. Todo problema lleva en `file` el archivo que lo causó; el
 * `field` del lector (el dato de la factura que falta o es inválido) se conserva.
 */
export function readInvoices<T extends UploadedFile>(files: readonly T[], maxXmlBytes: number) {
  const read: ReadInvoice<T>[] = []
  const problems: Problem[] = []
  for (const file of files) {
    if (file.size > maxXmlBytes) {
      problems.push(createProblem('XML_TOO_LARGE', { file: file.originalname }))
      continue
    }
    const result = parseUblInvoice(decodeXml(file.buffer), { maxLength: maxXmlBytes })
    if (result.ok) read.push({ file, invoice: result.invoice })
    else problems.push({ ...result.problem, file: file.originalname })
  }
  return { read, problems }
}
```

`apps/api/src/security/turnstile.verifier.ts`:
```ts
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

export interface TurnstileVerifier {
  /** true si el token es válido; lanza si Cloudflare no responde (la API contesta 503, no deja pasar). */
  verify(token: string, remoteIp: string): Promise<boolean>
}

export const TURNSTILE_VERIFIER = Symbol('TURNSTILE_VERIFIER')

const siteverifyResponse = z.object({
  success: z.boolean(),
  hostname: z.string().optional(),
  'error-codes': z.array(z.string()).default([]),
})

export class CloudflareTurnstileVerifier implements TurnstileVerifier {
  constructor(private readonly options: { secretKey: string; expectedHostname: string | undefined }) {}

  async verify(token: string, remoteIp: string): Promise<boolean> {
    if (!token || token.length > 2048) return false
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        secret: this.options.secretKey,
        response: token,
        remoteip: remoteIp,
        idempotency_key: randomUUID(),
      }),
      signal: AbortSignal.timeout(5_000),
    })
    const parsed = siteverifyResponse.safeParse(await response.json())
    if (!parsed.success || !parsed.data.success) return false
    if (this.options.expectedHostname && parsed.data.hostname !== this.options.expectedHostname) return false
    return true
  }
}
```

`apps/api/src/security/turnstile.guard.ts`:
```ts
import { createProblem } from '@anticipate/shared/errors'
import { type CanActivate, type ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common'
import type { Request } from 'express'
import { resolveClientIp } from '../common/client-ip.js'
import { ProblemsException } from '../common/problems.exception.js'
import type { AppConfig } from '../config/app-config.js'
import { APP_CONFIG } from '../config/config.module.js'
import { TURNSTILE_VERIFIER, type TurnstileVerifier } from './turnstile.verifier.js'

export const TURNSTILE_HEADER = 'x-turnstile-token'

/** Corre antes de los interceptores: el token se verifica antes de que multer lea los archivos. */
@Injectable()
export class TurnstileGuard implements CanActivate {
  private readonly logger = new Logger(TurnstileGuard.name)

  constructor(
    @Inject(TURNSTILE_VERIFIER) private readonly verifier: TurnstileVerifier,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>()
    const token = req.get(TURNSTILE_HEADER)?.trim() ?? ''
    // Sin token no hay nada que verificar: se rechaza sin depender de lo que haga el verificador.
    if (!token) throw new ProblemsException([createProblem('CAPTCHA_FAILED')], 403)
    let valid: boolean
    try {
      valid = await this.verifier.verify(token, resolveClientIp(req, this.config.trustCloudflareHeaders))
    } catch (error) {
      this.logger.error({ err: error }, 'Turnstile no respondió')
      throw new ProblemsException([createProblem('SERVICE_UNAVAILABLE')], 503)
    }
    if (!valid) throw new ProblemsException([createProblem('CAPTCHA_FAILED')], 403)
    return true
  }
}
```

`apps/api/src/security/security.module.ts`:
```ts
import { Module } from '@nestjs/common'
import type { AppConfig } from '../config/app-config.js'
import { APP_CONFIG } from '../config/config.module.js'
import { TurnstileGuard } from './turnstile.guard.js'
import { CloudflareTurnstileVerifier, TURNSTILE_VERIFIER } from './turnstile.verifier.js'

@Module({
  providers: [
    TurnstileGuard,
    {
      provide: TURNSTILE_VERIFIER,
      inject: [APP_CONFIG],
      useFactory: ({ turnstile }: AppConfig) => new CloudflareTurnstileVerifier(turnstile),
    },
  ],
  exports: [TurnstileGuard, TURNSTILE_VERIFIER],
})
export class SecurityModule {}
```

Run: `pnpm --filter @anticipate/api exec vitest run --project api:unit src/invoices src/security`
Expected: 10 tests PASS.

- [ ] **Step 3: Límite de bytes y errores de multer en español**

`apps/api/src/common/body-limit.middleware.ts`:
```ts
import type { NextFunction, Request, Response } from 'express'
import { HTTP_ERRORS_ES, HTTP_MESSAGES_ES } from './http-messages.es.js'

/**
 * Rechaza por `Content-Length` antes de leer el cuerpo. Un envío multipart sin tamaño declarado
 * (chunked) se rechaza con 411: sin él no se puede acotar el costo de leerlo.
 */
export function bodyLimit(maxBytes: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const declared = req.headers['content-length']
    if (declared === undefined) {
      res.status(411).json({ statusCode: 411, error: HTTP_ERRORS_ES[411], message: HTTP_MESSAGES_ES.lengthRequired })
      return
    }
    if (!/^\d+$/.test(declared) || Number(declared) > maxBytes) {
      res.status(413).json({ statusCode: 413, error: HTTP_ERRORS_ES[413], message: HTTP_MESSAGES_ES.payloadTooLarge })
      return
    }
    next()
  }
}
```

Agregar a `HTTP_MESSAGES_ES` en `http-messages.es.ts`:
```ts
  tooManyFiles: 'Adjuntaste más archivos de los permitidos.',
  unexpectedFile: 'El envío trae archivos en un campo no permitido. Usa los campos xml y pdf.',
  invalidMultipart: 'El envío no tiene el formato esperado.',
```

En `problems.filter.ts`, a nivel de módulo, la traducción de los mensajes con los que Nest envuelve los errores de multer y busboy (`transformException` de `@nestjs/platform-express`; cuando el error trae campo, Nest agrega ` - <campo>` al final, por eso se compara el inicio):
```ts
/** Errores de multer/busboy que Nest convierte en 400, con su texto en español. */
const MULTIPART_MESSAGES: ReadonlyArray<readonly [prefix: string, message: string]> = [
  ['Too many files', HTTP_MESSAGES_ES.tooManyFiles],
  ['Too many parts', HTTP_MESSAGES_ES.tooManyFiles],
  ['Unexpected field', HTTP_MESSAGES_ES.unexpectedFile],
  ['Too many fields', HTTP_MESSAGES_ES.invalidMultipart],
  ['Field value too long', HTTP_MESSAGES_ES.invalidMultipart],
  ['Field name too long', HTTP_MESSAGES_ES.invalidMultipart],
  ['Field name missing', HTTP_MESSAGES_ES.invalidMultipart],
  ['Boundary not found', HTTP_MESSAGES_ES.invalidMultipart],
  ['Multipart:', HTTP_MESSAGES_ES.invalidMultipart],
]

const multipartMessage = (body: unknown): string | undefined => {
  const message = typeof body === 'object' && body !== null ? (body as { message?: unknown }).message : undefined
  if (typeof message !== 'string') return undefined
  return MULTIPART_MESSAGES.find(([prefix]) => message.startsWith(prefix))?.[1]
}
```
y en `catch`, justo antes del caso genérico `if (exception instanceof HttpException && status < 500)`:
```ts
    if (exception instanceof HttpException && status === HttpStatus.BAD_REQUEST) {
      const message = multipartMessage(exception.getResponse())
      if (message) {
        send(status, { message })
        return
      }
    }
```

- [ ] **Step 4: El pipe del campo `form`**

`apps/api/src/advance-requests/advance-request-form.pipe.ts`:
```ts
import { type AdvanceRequestForm, advanceRequestFormSchema } from '@anticipate/shared/advance-request'
import { BadRequestException, type PipeTransform } from '@nestjs/common'
import { HTTP_ERRORS_ES } from '../common/http-messages.es.js'

export const FORM_NOT_JSON = 'El campo form debe ser un JSON válido.'

/** El formulario viaja como texto JSON dentro del multipart; se valida con el esquema de shared. */
export class AdvanceRequestFormPipe implements PipeTransform<unknown, AdvanceRequestForm> {
  transform(value: unknown): AdvanceRequestForm {
    let raw: unknown
    try {
      raw = typeof value === 'string' ? JSON.parse(value) : undefined
    } catch {
      raw = undefined
    }
    if (raw === undefined) {
      throw new BadRequestException({ statusCode: 400, error: HTTP_ERRORS_ES[400], errors: [{ field: 'form', message: FORM_NOT_JSON }] })
    }
    const result = advanceRequestFormSchema.safeParse(raw)
    if (!result.success) {
      throw new BadRequestException({
        statusCode: 400,
        error: HTTP_ERRORS_ES[400],
        errors: result.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
      })
    }
    return result.data
  }
}
```

- [ ] **Step 5: El servicio de creación**

`apps/api/src/advance-requests/advance-requests.service.ts`:
```ts
import { randomUUID } from 'node:crypto'
import {
  type AdvanceRequestForm,
  advanceRequestCreatedEventSchema,
  formatPublicCode,
} from '@anticipate/shared/advance-request'
import { type IsoDate, LIMA_TIME_ZONE, todayIn } from '@anticipate/shared/dates'
import { createProblem, type Problem } from '@anticipate/shared/errors'
import {
  invoiceKey,
  type ParsedInvoice,
  validateInvoices,
  validateRequestedAmount,
} from '@anticipate/shared/invoice'
import type { Currency } from '@anticipate/shared/money'
import { Inject, Injectable, Logger } from '@nestjs/common'
import { ProblemsException } from '../common/problems.exception.js'
import type { AppConfig } from '../config/app-config.js'
import { CLOCK, type Clock } from '../config/clock.js'
import { APP_CONFIG } from '../config/config.module.js'
import { readInvoices } from '../invoices/invoice-reader.js'
import { pairPdfs, type UploadedFile } from '../invoices/uploaded-files.js'
import { buildValidationContext, type PayerRecord } from '../invoices/validation-context.js'
import { OutboxService } from '../notifications/outbox.service.js'
import { PayersService } from '../payers/payers.service.js'
import { isoDateToDb } from '../prisma/db-values.js'
import { isUniqueViolation } from '../prisma/prisma-errors.js'
import { PrismaService, type Tx } from '../prisma/prisma.service.js'
import { StorageService, type StoredObject } from '../storage/storage.service.js'
import { storageKeys } from '../storage/storage-keys.js'

export type CreateAdvanceRequestInput = {
  form: AdvanceRequestForm
  xmlFiles: readonly UploadedFile[]
  pdfFiles: readonly UploadedFile[]
  clientIp: string
}

/** Índice único parcial de facturas activas (schema.prisma, D26). */
const ACTIVE_INVOICE_INDEX = 'invoices_active_invoice_key_key'

type FileToStore = {
  id: string
  key: string
  contentType: 'application/xml' | 'application/pdf'
  upload: UploadedFile
}
type InvoiceToStore = { id: string; key: string; invoice: ParsedInvoice; xml: FileToStore; pdf: FileToStore | null }

/** Todo lo validado y subido que la transacción necesita para guardar la solicitud. */
type Draft = {
  requestId: string
  payer: PayerRecord
  form: AdvanceRequestForm
  currency: Currency
  invoices: readonly InvoiceToStore[]
  files: readonly FileToStore[]
  stored: ReadonlyMap<string, StoredObject>
  clientIp: string
  now: Date
  today: IsoDate
}

/** Vencimiento de la factura: el de su última cuota (las reglas exigen al menos una al crédito). */
const lastDueDate = (invoice: ParsedInvoice): IsoDate =>
  invoice.installments.map((i) => i.dueDate).sort().at(-1) ?? invoice.issueDate

@Injectable()
export class AdvanceRequestsService {
  private readonly logger = new Logger(AdvanceRequestsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly payers: PayersService,
    private readonly storage: StorageService,
    private readonly outbox: OutboxService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async create(input: CreateAdvanceRequestInput): Promise<{ publicCode: string }> {
    const now = this.clock.now()
    const today = todayIn(LIMA_TIME_ZONE, now)
    const { form } = input

    const payer = await this.payers.findActiveBySlug(form.payerSlug)
    if (!payer) {
      throw new ProblemsException([
        createProblem('PAYER_NOT_AVAILABLE', { field: 'payerSlug', data: { payer: form.payerSlug } }),
      ])
    }

    // 1. Lectura, emparejamiento y reglas de shared: todos los problemas juntos, en una sola respuesta.
    const { upload } = this.config
    const { read, problems: readProblems } = readInvoices(input.xmlFiles, upload.maxXmlBytes)
    const { pdfByXml, problems: pdfProblems } = pairPdfs(input.xmlFiles, input.pdfFiles, upload.maxPdfBytes)
    // Si ningún XML se pudo leer, "adjunta al menos una factura" sería ruido: ya hay un problema por archivo.
    const validation =
      read.length > 0 || readProblems.length === 0
        ? validateInvoices(
            read.map((r) => r.invoice),
            buildValidationContext(payer, form.company.ruc, today),
          )
        : null
    const problems: Problem[] = [...readProblems, ...pdfProblems, ...(validation?.problems ?? [])]
    // El máximo se calcula sobre las facturas válidas: solo tiene sentido si todas lo son.
    if (problems.length === 0 && validation) {
      const amountProblem = validateRequestedAmount(form.financing.requestedAmount, validation)
      if (amountProblem) problems.push(amountProblem)
    }
    if (problems.length > 0) throw new ProblemsException(problems)
    // `validateRequestedAmount` ya exige moneda común; esto solo estrecha el tipo.
    const currency = validation?.currency
    if (!currency) {
      throw new ProblemsException([createProblem('NO_MAXIMUM_AVAILABLE', { field: 'requestedAmount' })])
    }

    const requestId = randomUUID()
    const fileFor = (file: UploadedFile, invoiceId: string, kind: 'xml' | 'pdf'): FileToStore => ({
      id: randomUUID(),
      key:
        kind === 'xml'
          ? storageKeys.invoiceXml(payer.id, requestId, invoiceId)
          : storageKeys.invoicePdf(payer.id, requestId, invoiceId),
      contentType: kind === 'xml' ? 'application/xml' : 'application/pdf',
      upload: file,
    })
    const invoices: InvoiceToStore[] = read.map(({ file, invoice }) => {
      const id = randomUUID()
      const pdf = pdfByXml.get(file)
      return {
        id,
        key: invoiceKey(invoice),
        invoice,
        xml: fileFor(file, id, 'xml'),
        pdf: pdf ? fileFor(pdf, id, 'pdf') : null,
      }
    })
    const files = invoices.flatMap((i) => (i.pdf ? [i.xml, i.pdf] : [i.xml]))

    // 2. Primera barrera contra facturas repetidas: evita subir archivos en vano. La definitiva es el índice único.
    await this.assertInvoicesAvailable(invoices)

    // 3. Archivos, todo o nada, antes de la transacción: la transacción no queda abierta durante la red.
    let stored: Map<string, StoredObject>
    try {
      const objects = await this.storage.putAll(
        files.map((f) => ({ key: f.key, body: f.upload.buffer, contentType: f.contentType })),
      )
      stored = new Map(objects.map((o) => [o.key, o]))
    } catch (error) {
      this.logger.error({ err: error, advanceRequestId: requestId }, 'no se pudieron subir los archivos')
      throw new ProblemsException([createProblem('SERVICE_UNAVAILABLE')], 503)
    }

    // 4. Todo lo demás en una transacción; si falla, se borran los archivos recién subidos.
    const draft: Draft = { requestId, payer, form, currency, invoices, files, stored, clientIp: input.clientIp, now, today }
    try {
      const publicCode = await this.prisma.$transaction((tx) => this.persist(tx, draft), {
        maxWait: 5_000,
        timeout: 15_000,
      })
      return { publicCode }
    } catch (error) {
      await this.storage.deleteQuietly(files.map((f) => f.key))
      if (isUniqueViolation(error, ACTIVE_INVOICE_INDEX)) {
        // Otro envío ganó la carrera por la misma factura entre la verificación previa y el insert, y ya
        // confirmó: la verificación ahora dice cuál. Si ya no la encuentra (se cerró en el intermedio),
        // un reintento sí pasaría, y el 503 de abajo es la respuesta correcta.
        await this.assertInvoicesAvailable(invoices)
      }
      this.logger.error({ err: error, advanceRequestId: requestId }, 'no se pudo guardar la solicitud')
      throw new ProblemsException([createProblem('SERVICE_UNAVAILABLE')], 503)
    }
  }

  /** Guarda la solicitud completa y sus dos correos. Corre dentro de la transacción: todo o nada. */
  private async persist(tx: Tx, d: Draft): Promise<string> {
    const [row] = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval('advance_request_code_seq') AS n`
    if (!row) throw new Error('La secuencia del código público no devolvió valor')
    const publicCode = formatPublicCode({
      prefix: this.config.publicCodePrefix,
      year: Number(d.today.slice(0, 4)),
      sequence: Number(row.n),
    })
    const { form } = d

    // Proveedor y representante se reutilizan; lo que ya está guardado (y el admin pudo corregir) no se pisa.
    const supplier = await tx.supplier.upsert({
      where: { ruc: form.company.ruc },
      create: { ruc: form.company.ruc, legalName: form.company.legalName },
      update: {},
    })
    if (form.contact.isLegalRepresentative) {
      await tx.legalRepresentative.upsert({
        where: { supplierId_dni: { supplierId: supplier.id, dni: form.contact.dni } },
        create: {
          supplierId: supplier.id,
          fullName: form.contact.fullName,
          dni: form.contact.dni,
          jobTitle: form.contact.jobTitle ?? null,
        },
        update: {},
      })
    }

    await tx.advanceRequest.create({
      data: {
        id: d.requestId,
        publicCode,
        payerId: d.payer.id,
        supplierId: supplier.id,
        contactFullName: form.contact.fullName,
        contactDni: form.contact.dni,
        contactMobile: form.contact.mobile,
        contactEmail: form.contact.email,
        isLegalRepresentative: form.contact.isLegalRepresentative,
        contactJobTitle: form.contact.jobTitle ?? null,
        contactTimeSlot: form.contact.contactTimeSlot,
        requestedAmount: form.financing.requestedAmount,
        currency: d.currency,
        purpose: form.financing.purpose ?? null,
        cavaliRegistration: form.cavaliRegistration,
        utm: form.source?.utm,
        referrer: form.source?.referrer ?? null,
      },
    })

    await tx.storedFile.createMany({
      data: d.files.map((f) => {
        const object = d.stored.get(f.key)
        if (!object) throw new Error(`Archivo no subido: ${f.key}`)
        return {
          id: f.id,
          key: f.key,
          contentType: f.contentType,
          sizeBytes: object.sizeBytes,
          sha256: object.sha256,
          originalName: f.upload.originalname.slice(0, 255),
        }
      }),
    })

    // Aquí actúa el índice único parcial: una factura activa en otra solicitud aborta la transacción.
    await tx.invoice.createMany({
      data: d.invoices.map(({ id, key, invoice, xml, pdf }) => ({
        id,
        advanceRequestId: d.requestId,
        documentType: invoice.documentType,
        seriesNumber: invoice.seriesNumber,
        invoiceKey: key,
        issuerRuc: invoice.issuerRuc,
        issuerName: invoice.issuerName,
        recipientRuc: invoice.recipientRuc,
        // Solo llegan aquí facturas al crédito con neto pendiente (regla credit-with-pending-amount).
        paymentTerms: 'CREDIT' as const,
        total: invoice.total,
        netPendingAmount: invoice.netPendingAmount ?? '0.00',
        currency: d.currency,
        issueDate: isoDateToDb(invoice.issueDate),
        dueDate: isoDateToDb(lastDueDate(invoice)),
        installments: invoice.installments,
        detraction: invoice.detraction ?? undefined,
        signed: invoice.signed,
        xmlFileId: xml.id,
        pdfFileId: pdf?.id ?? null,
      })),
    })

    await tx.consent.createMany({
      data: [
        { type: 'TERMS' as const, documentVersion: form.consents.termsVersion },
        { type: 'PERSONAL_DATA' as const, documentVersion: form.consents.privacyVersion },
      ].map((c) => ({ ...c, advanceRequestId: d.requestId, ip: d.clientIp.slice(0, 45), acceptedAt: d.now })),
    })
    await tx.statusHistory.create({
      data: { advanceRequestId: d.requestId, fromStatus: null, toStatus: 'NEW' },
    })

    // El evento se valida con el esquema de shared antes de encolarlo: el dispatcher lo vuelve a leer así.
    const event = advanceRequestCreatedEventSchema.parse({
      id: randomUUID(),
      occurredAt: d.now.toISOString(),
      version: 1,
      type: 'advance-request.created',
      payload: {
        advanceRequestId: d.requestId,
        publicCode,
        payerSlug: d.payer.slug,
        supplierRuc: form.company.ruc,
        currency: d.currency,
        requestedAmount: form.financing.requestedAmount,
        invoiceCount: d.invoices.length,
        contactEmail: form.contact.email,
      },
    })
    await this.outbox.enqueue(tx, { advanceRequestId: d.requestId, notification: 'SUPPLIER_CONFIRMATION', event })
    await this.outbox.enqueue(tx, { advanceRequestId: d.requestId, notification: 'TEAM_ALERT', event })
    return publicCode
  }

  /** 422 con una línea por cada factura que ya está en una solicitud viva. */
  private async assertInvoicesAvailable(invoices: readonly InvoiceToStore[]): Promise<void> {
    const taken = await this.prisma.invoice.findMany({
      where: { active: true, invoiceKey: { in: invoices.map((i) => i.key) } },
      select: { invoiceKey: true },
    })
    if (taken.length === 0) return
    const takenKeys = new Set(taken.map((t) => t.invoiceKey))
    throw new ProblemsException(
      invoices
        .filter((i) => takenKeys.has(i.key))
        .map(({ invoice, xml }) =>
          createProblem('INVOICE_ALREADY_IN_OPEN_REQUEST', {
            invoice: invoice.seriesNumber,
            file: xml.upload.originalname,
            data: { invoice: invoice.seriesNumber },
          }),
        ),
    )
  }
}
```

Nota para quien implemente: si `tsc` no acepta `installments` o `utm` como `InputJsonValue` (los tipos de `shared` son alias de objeto, que TypeScript sí acepta como índice), usar `satisfies Prisma.InputJsonValue` en vez de un `as`; nunca `as unknown as`.

- [ ] **Step 6: El controlador y el módulo**

`apps/api/src/advance-requests/advance-requests.controller.ts`:
```ts
import type { AdvanceRequestForm } from '@anticipate/shared/advance-request'
import { Body, Controller, HttpCode, Inject, Post, Req, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common'
import { FileFieldsInterceptor } from '@nestjs/platform-express'
import type { Request } from 'express'
import { resolveClientIp } from '../common/client-ip.js'
import { SubmitThrottle } from '../common/submit-throttle.js'
import type { AppConfig } from '../config/app-config.js'
import { APP_CONFIG } from '../config/config.module.js'
import { TurnstileGuard } from '../security/turnstile.guard.js'
import { AdvanceRequestFormPipe } from './advance-request-form.pipe.js'
import { AdvanceRequestsService } from './advance-requests.service.js'

// Tope por campo en el decorador (estático); el límite real de archivos lo pone MulterModule desde la configuración.
const MAX_FILES_PER_FIELD = 100

@Controller('advance-requests')
export class AdvanceRequestsController {
  constructor(
    private readonly service: AdvanceRequestsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post()
  @HttpCode(201)
  @SubmitThrottle()
  @UseGuards(TurnstileGuard)
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'xml', maxCount: MAX_FILES_PER_FIELD },
      { name: 'pdf', maxCount: MAX_FILES_PER_FIELD },
    ]),
  )
  create(
    @Body('form', new AdvanceRequestFormPipe()) form: AdvanceRequestForm,
    @UploadedFiles() files: { xml?: Express.Multer.File[]; pdf?: Express.Multer.File[] } | undefined,
    @Req() req: Request,
  ) {
    return this.service.create({
      form,
      xmlFiles: files?.xml ?? [],
      pdfFiles: files?.pdf ?? [],
      clientIp: resolveClientIp(req, this.config.trustCloudflareHeaders),
    })
  }
}
```

`apps/api/src/advance-requests/advance-requests.module.ts`:
```ts
import { type MiddlewareConsumer, Module, type NestModule, RequestMethod, Inject } from '@nestjs/common'
import { MulterModule } from '@nestjs/platform-express'
import { bodyLimit } from '../common/body-limit.middleware.js'
import type { AppConfig } from '../config/app-config.js'
import { APP_CONFIG } from '../config/config.module.js'
import { NotificationsModule } from '../notifications/notifications.module.js'
import { PayersModule } from '../payers/payers.module.js'
import { SecurityModule } from '../security/security.module.js'
import { AdvanceRequestsController } from './advance-requests.controller.js'
import { AdvanceRequestsService } from './advance-requests.service.js'

@Module({
  imports: [
    PayersModule,
    NotificationsModule,
    SecurityModule,
    MulterModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: ({ upload }: AppConfig) => ({
        // En memoria (por defecto): el cuerpo ya está acotado por Content-Length. El tope por archivo
        // (XML y PDF distintos) lo revisa el servicio para responder 422 con el nombre de cada archivo;
        // `fileSize` aquí es solo una defensa extra y nunca es el límite que actúa.
        limits: {
          fileSize: upload.maxBodyBytes,
          files: upload.maxFiles,
          fields: 4,
          parts: upload.maxFiles + 4,
          fieldSize: 64 * 1024,
        },
      }),
    }),
  ],
  controllers: [AdvanceRequestsController],
  providers: [AdvanceRequestsService],
})
export class AdvanceRequestsModule implements NestModule {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(bodyLimit(this.config.upload.maxBodyBytes))
      .forRoutes({ path: 'advance-requests', method: RequestMethod.POST })
  }
}
```

Agregar `AdvanceRequestsModule` a `AppModule.register` (trae consigo `SecurityModule`, que exporta el verificador que necesita el guard). `AppModule` y `AdvanceRequestsModule` importan los dos `NotificationsModule` y `PayersModule`: son módulos estáticos, así que Nest crea una sola instancia de cada uno (un solo `OutboxService`, un solo `PayersController`).

El orden en que Nest ejecuta todo esto es el del flujo: el middleware `bodyLimit` (antes de leer el cuerpo), el `ThrottlerGuard` global, el `TurnstileGuard` de la ruta, el interceptor de multer (recién aquí se leen los archivos), el pipe de `form` y el servicio.

- [ ] **Step 7: Fixtures y test de integración que falla**

`apps/api/test/support/advance-request-fixtures.ts`:
```ts
import { buildInvoiceXml, type TestXmlOptions } from '@anticipate/shared/testing'
import type { AdvanceRequestForm } from '@anticipate/shared/advance-request'

export const validForm = (overrides: Partial<AdvanceRequestForm> = {}): AdvanceRequestForm => ({
  payerSlug: 'sea',
  contact: {
    fullName: 'Ana Pérez',
    dni: '46728673',
    mobile: '987654321',
    email: 'ana@proveedor.pe',
    isLegalRepresentative: true,
    contactTimeSlot: 'MORNING',
  },
  company: { ruc: '20100070970', legalName: 'PROVEEDOR EJEMPLO S.A.C.' },
  financing: { requestedAmount: '8000.00', purpose: 'Capital de trabajo' },
  cavaliRegistration: 'UNKNOWN',
  consents: { terms: true, personalData: true, termsVersion: '2026-09', privacyVersion: '2026-09' },
  source: { utm: { utm_source: 'linkedin' }, referrer: 'https://www.linkedin.com/' },
  ...overrides,
})

export const invoiceXml = (options: TestXmlOptions = {}) => Buffer.from(buildInvoiceXml(options), 'utf8')
export const pdf = () => Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n')
```
(Si `AdvanceRequestForm` exige campos que el fixture no trae, completarlos con valores válidos del esquema de `shared`.)

`apps/api/test/support/s3.ts`:
```ts
import { ListObjectsV2Command } from '@aws-sdk/client-s3'
import { createS3Client } from '../../src/storage/s3-client.factory.js'
import { testConfig } from './config.js'

const config = testConfig()
const s3 = createS3Client(config.storage)

export async function listKeys(prefix: string): Promise<string[]> {
  const out = await s3.send(new ListObjectsV2Command({ Bucket: config.storage.bucket, Prefix: prefix }))
  return (out.Contents ?? []).map((o) => o.Key ?? '').sort()
}
```

`apps/api/test/integration/advance-requests.test.ts`:
```ts
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeMailSender } from '../../src/notifications/mail/fake-mail-sender.js'
import { MAIL_SENDER } from '../../src/notifications/mail/mail-sender.js'
import { OutboxProcessor } from '../../src/notifications/outbox-processor.js'
import { TURNSTILE_VERIFIER } from '../../src/security/turnstile.verifier.js'
import { invoiceXml, pdf, validForm } from '../support/advance-request-fixtures.js'
import { createTestApp } from '../support/app.js'
import { createTestPrisma, truncateAll } from '../support/db.js'
import { createPayer } from '../support/factories.js'
import { listKeys } from '../support/s3.js'

const turnstile = { valid: true, calls: 0, async verify() { this.calls++; return this.valid } }
const mailer = new FakeMailSender()
const db = createTestPrisma()
let app: Awaited<ReturnType<typeof createTestApp>>
let payerId: string

const submit = (options: { form?: unknown; xml?: [Buffer, string][]; pdf?: [Buffer, string][]; token?: string | null } = {}) => {
  let req = request(app.getHttpServer()).post('/advance-requests')
  if (options.token !== null) req = req.set('x-turnstile-token', options.token ?? 'token-de-prueba')
  req = req.field('form', typeof options.form === 'string' ? options.form : JSON.stringify(options.form ?? validForm()))
  for (const [buffer, name] of options.xml ?? [[invoiceXml(), 'F001-123.xml']]) req = req.attach('xml', buffer, name)
  for (const [buffer, name] of options.pdf ?? []) req = req.attach('pdf', buffer, name)
  return req
}

beforeAll(async () => {
  app = await createTestApp({
    env: { THROTTLE_SUBMIT_LIMIT: '1000' },
    overrides: [
      [TURNSTILE_VERIFIER, turnstile],
      [MAIL_SENDER, mailer],
    ],
  })
})
beforeEach(async () => {
  await truncateAll(db.prisma)
  payerId = (await createPayer(db.prisma)).id
  turnstile.valid = true
  turnstile.calls = 0
  mailer.reset()
})
afterAll(async () => {
  await app.close()
  await db.close()
})

describe('POST /advance-requests · camino feliz', () => {
  it('guarda todo, sube los archivos y deja dos correos en el outbox', async () => {
    const res = await submit({ pdf: [[pdf(), 'F001-123.pdf']] }).expect(201)
    expect(res.body).toEqual({ publicCode: 'ANT-2026-000001' })

    const saved = await db.prisma.advanceRequest.findUniqueOrThrow({
      where: { publicCode: 'ANT-2026-000001' },
      include: { invoices: true, consents: true, statusHistory: true, outboxEvents: true, supplier: { include: { legalRepresentatives: true } } },
    })
    expect(saved).toMatchObject({ status: 'NEW', currency: 'PEN', version: 1, contactEmail: 'ana@proveedor.pe' })
    expect(saved.requestedAmount.toFixed(2)).toBe('8000.00')
    expect(saved.supplier.ruc).toBe('20100070970')
    expect(saved.supplier.legalRepresentatives.map((r) => r.dni)).toEqual(['46728673'])
    expect(saved.invoices).toHaveLength(1)
    expect(saved.invoices[0]).toMatchObject({ invoiceKey: '20100070970|F001-123', active: true, paymentTerms: 'CREDIT' })
    expect(saved.invoices[0]?.pdfFileId).not.toBeNull()
    expect(saved.consents.map((c) => c.type).sort()).toEqual(['PERSONAL_DATA', 'TERMS'])
    expect(saved.statusHistory.map((h) => [h.fromStatus, h.toStatus])).toEqual([[null, 'NEW']])
    expect(saved.outboxEvents.map((e) => e.notification).sort()).toEqual(['SUPPLIER_CONFIRMATION', 'TEAM_ALERT'])

    const keys = await listKeys(`payers/${payerId}/`)
    expect(keys).toHaveLength(2)
    expect(keys.every((k) => k.startsWith(`payers/${payerId}/advance-requests/${saved.id}/invoices/`))).toBe(true)

    await expect(app.get(OutboxProcessor).drain()).resolves.toEqual({ sent: 2, failed: 0 })
    expect(mailer.sent.map((m) => m.subject).sort()).toEqual([
      'Nueva solicitud ANT-2026-000001 · SEA',
      'Recibimos tu solicitud ANT-2026-000001',
    ])
  })

  it('una segunda solicitud del mismo proveedor reutiliza proveedor y representante', async () => {
    await submit().expect(201)
    await submit({ xml: [[invoiceXml({ seriesNumber: 'F001-124' }), 'F001-124.xml']] }).expect(201)
    expect(await db.prisma.supplier.count()).toBe(1)
    expect(await db.prisma.legalRepresentative.count()).toBe(1)
    expect((await db.prisma.advanceRequest.findMany({ orderBy: { publicCode: 'asc' } })).map((r) => r.publicCode)).toEqual([
      'ANT-2026-000001',
      'ANT-2026-000002',
    ])
  })
})

describe('POST /advance-requests · rechazos antes de leer archivos', () => {
  it('sin Turnstile válido: 403 y nada guardado', async () => {
    turnstile.valid = false
    const res = await submit().expect(403)
    expect(res.body.problems.map((p: { code: string }) => p.code)).toEqual(['CAPTCHA_FAILED'])
    expect(await db.prisma.advanceRequest.count()).toBe(0)
    expect(await listKeys(`payers/${payerId}/`)).toEqual([])
  })

  it('sin cabecera de Turnstile: 403 sin consultar a Cloudflare', async () => {
    const res = await submit({ token: null }).expect(403)
    expect(res.body.problems.map((p: { code: string }) => p.code)).toEqual(['CAPTCHA_FAILED'])
    expect(turnstile.calls).toBe(0)
  })
})

describe('POST /advance-requests · problemas de forma y de negocio', () => {
  it('un form que no es JSON: 400 en español', async () => {
    const res = await submit({ form: '{no es json' }).expect(400)
    expect(res.body.errors).toEqual([{ field: 'form', message: 'El campo form debe ser un JSON válido.' }])
  })

  it('un form inválido: 400 con el campo de cada error', async () => {
    const res = await submit({ form: { ...validForm(), company: { ruc: '123', legalName: 'X' } } }).expect(400)
    expect(res.body.errors.map((e: { field: string }) => e.field)).toContain('company.ruc')
  })

  it('un pagador inexistente: 422 PAYER_NOT_AVAILABLE', async () => {
    const res = await submit({ form: validForm({ payerSlug: 'no-existe' }) }).expect(422)
    expect(res.body.problems[0]).toMatchObject({ code: 'PAYER_NOT_AVAILABLE', field: 'payerSlug' })
  })

  it('junta los problemas de todas las facturas en una sola respuesta', async () => {
    const res = await submit({
      xml: [
        [invoiceXml({ seriesNumber: 'F001-1', recipientRuc: '20100070970' }), 'F001-1.xml'],
        [Buffer.from('%PDF-1.7 no soy xml'), 'F001-2.xml'],
      ],
      pdf: [[Buffer.from('tampoco soy pdf'), 'F001-1.pdf'], [pdf(), 'F001-9.pdf']],
    }).expect(422)
    const codes = res.body.problems.map((p: { code: string }) => p.code).sort()
    expect(codes).toEqual(['INVALID_PDF', 'PDF_WITHOUT_XML', 'RECIPIENT_IS_NOT_PAYER', 'UNREADABLE_XML'])
    expect(await listKeys(`payers/${payerId}/`)).toEqual([])
  })

  it('un monto mayor al máximo: 422 AMOUNT_EXCEEDS_MAXIMUM', async () => {
    const res = await submit({ form: validForm({ financing: { requestedAmount: '9000.00' } }) }).expect(422)
    expect(res.body.problems[0]).toMatchObject({ code: 'AMOUNT_EXCEEDS_MAXIMUM', field: 'requestedAmount' })
  })
})

describe('POST /advance-requests · facturas repetidas y concurrencia', () => {
  it('una factura que ya está en una solicitud viva: 422 y ningún archivo subido', async () => {
    await submit().expect(201)
    const before = await listKeys(`payers/${payerId}/`)
    const res = await submit().expect(422)
    expect(res.body.problems).toEqual([
      expect.objectContaining({ code: 'INVOICE_ALREADY_IN_OPEN_REQUEST', invoice: 'F001-123' }),
    ])
    expect(await listKeys(`payers/${payerId}/`)).toEqual(before)
  })

  it('dos envíos simultáneos con la misma factura: uno gana y el otro no deja archivos', async () => {
    const [a, b] = await Promise.all([submit(), submit()])
    expect([a.status, b.status].sort()).toEqual([201, 422])
    const saved = await db.prisma.advanceRequest.findMany({ include: { invoices: true } })
    expect(saved).toHaveLength(1)
    const keys = await listKeys(`payers/${payerId}/`)
    expect(keys.every((k) => k.includes(`/advance-requests/${saved[0]?.id}/`))).toBe(true)
  })

  it('si la transacción falla, no quedan archivos huérfanos', async () => {
    await db.prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_fail_consents() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'falla simulada'; END $$;
      CREATE TRIGGER test_fail_consents BEFORE INSERT ON consents FOR EACH ROW EXECUTE FUNCTION test_fail_consents();
    `)
    try {
      const res = await submit({ pdf: [[pdf(), 'F001-123.pdf']] }).expect(503)
      expect(res.body.problems.map((p: { code: string }) => p.code)).toEqual(['SERVICE_UNAVAILABLE'])
      expect(await db.prisma.advanceRequest.count()).toBe(0)
      expect(await listKeys(`payers/${payerId}/`)).toEqual([])
    } finally {
      await db.prisma.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS test_fail_consents ON consents;
        DROP FUNCTION IF EXISTS test_fail_consents();
      `)
    }
  })
})

describe('POST /advance-requests · límites', () => {
  it('un XML o un PDF mayor a su tope: 422 con el nombre de cada archivo', async () => {
    const small = await createTestApp({
      env: { UPLOAD_MAX_XML_BYTES: '1000', UPLOAD_MAX_PDF_BYTES: '20', THROTTLE_SUBMIT_LIMIT: '1000' },
      overrides: [[TURNSTILE_VERIFIER, turnstile], [MAIL_SENDER, mailer]],
    })
    try {
      const res = await request(small.getHttpServer())
        .post('/advance-requests')
        .set('x-turnstile-token', 't')
        .field('form', JSON.stringify(validForm()))
        .attach('xml', invoiceXml(), 'F001-123.xml')
        .attach('pdf', pdf(), 'F001-123.pdf')
        .expect(422)
      expect(res.body.problems).toEqual([
        expect.objectContaining({ code: 'XML_TOO_LARGE', file: 'F001-123.xml' }),
        expect.objectContaining({ code: 'FILE_TOO_LARGE', file: 'F001-123.pdf' }),
      ])
      expect(await listKeys(`payers/${payerId}/`)).toEqual([])
    } finally {
      await small.close()
    }
  })

  it('un cuerpo mayor al máximo: 413 antes de leerlo, sin consultar Turnstile', async () => {
    const small = await createTestApp({
      env: { UPLOAD_MAX_BODY_BYTES: '5000', THROTTLE_SUBMIT_LIMIT: '1000' },
      overrides: [[TURNSTILE_VERIFIER, turnstile], [MAIL_SENDER, mailer]],
    })
    try {
      const res = await request(small.getHttpServer())
        .post('/advance-requests')
        .set('x-turnstile-token', 't')
        .field('form', JSON.stringify(validForm()))
        .attach('pdf', Buffer.alloc(20_000, 0x20), 'grande.pdf')
        .expect(413)
      expect(res.body.message).toBe('El envío supera el tamaño máximo permitido.')
      expect(turnstile.calls).toBe(0)
    } finally {
      await small.close()
    }
  })

  it('más archivos que el máximo: 400 en español', async () => {
    const small = await createTestApp({
      env: { UPLOAD_MAX_FILES: '2', THROTTLE_SUBMIT_LIMIT: '1000' },
      overrides: [[TURNSTILE_VERIFIER, turnstile], [MAIL_SENDER, mailer]],
    })
    try {
      const res = await request(small.getHttpServer())
        .post('/advance-requests')
        .set('x-turnstile-token', 't')
        .field('form', JSON.stringify(validForm()))
        .attach('xml', invoiceXml({ seriesNumber: 'F001-1' }), 'F001-1.xml')
        .attach('xml', invoiceXml({ seriesNumber: 'F001-2' }), 'F001-2.xml')
        .attach('xml', invoiceXml({ seriesNumber: 'F001-3' }), 'F001-3.xml')
        .expect(400)
      expect(res.body.message).toBe('Adjuntaste más archivos de los permitidos.')
    } finally {
      await small.close()
    }
  })

  it('el límite de envíos por IP responde 429 en español', async () => {
    const limited = await createTestApp({
      env: { THROTTLE_SUBMIT_LIMIT: '1' },
      overrides: [[TURNSTILE_VERIFIER, turnstile], [MAIL_SENDER, mailer]],
    })
    try {
      const send = () =>
        request(limited.getHttpServer())
          .post('/advance-requests')
          .set('x-turnstile-token', 't')
          .field('form', JSON.stringify(validForm({ payerSlug: 'no-existe' })))
          .attach('xml', invoiceXml(), 'F001-123.xml')
      await send().expect(422)
      const res = await send().expect(429)
      expect(res.body.message).toBe('Hiciste demasiados envíos seguidos. Inténtalo de nuevo más tarde.')
    } finally {
      await limited.close()
    }
  })
})
```

Run: `pnpm --filter @anticipate/api test:integration -- advance-requests`
Expected: FAIL mientras falten piezas; al terminar los pasos 2 a 6, los 17 tests PASS.

Dos cosas a vigilar al correrlos. (a) Los tests de 413 y de límites dependen de que supertest envíe `Content-Length` en multipart: lo hace cuando todos los adjuntos son `Buffer` (form-data calcula el largo). Si un test recibe 411 en lugar del código esperado, ese es el motivo, no el middleware. (b) El test de 411 no está aquí porque supertest siempre envía el largo; va aparte, con `node:http` y `Transfer-Encoding: chunked`:
```ts
it('un envío sin Content-Length (chunked): 411 en español', async () => {
  const { request: httpRequest } = await import('node:http')
  const server = app.getHttpServer()
  if (!server.listening) await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as import('node:net').AddressInfo
  const status = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/advance-requests',
        headers: { 'content-type': 'multipart/form-data; boundary=x', 'transfer-encoding': 'chunked' },
      },
      (res) => resolve(res.statusCode ?? 0),
    )
    req.on('error', reject)
    req.end('--x--')
  })
  expect(status).toBe(411)
})
```
(se agrega al `describe('POST /advance-requests · límites')`; son 17 tests en total).

- [ ] **Step 8: Verificar el flujo real a mano**

Run:
```bash
pnpm infra:up && pnpm db:migrate && pnpm db:seed
pnpm --filter @anticipate/api build && (cd apps/api && node dist/main.js &) && sleep 5
(cd apps/api && node --input-type=module -e "const m = await import('@anticipate/shared/testing'); process.stdout.write(m.buildInvoiceXml())") > /tmp/F001-123.xml
curl -s -X POST http://127.0.0.1:4000/advance-requests \
  -H 'x-turnstile-token: XXXX.DUMMY.TOKEN.XXXX' \
  -F 'form={"payerSlug":"sea","contact":{"fullName":"Ana Pérez","dni":"46728673","mobile":"987654321","email":"ana@proveedor.pe","isLegalRepresentative":true,"contactTimeSlot":"MORNING"},"company":{"ruc":"20100070970","legalName":"PROVEEDOR EJEMPLO S.A.C."},"financing":{"requestedAmount":"8000.00"},"cavaliRegistration":"UNKNOWN","consents":{"terms":true,"personalData":true,"termsVersion":"2026-09","privacyVersion":"2026-09"}}' \
  -F 'xml=@/tmp/F001-123.xml'
```
Expected: `{"publicCode":"ANT-2026-000001"}` (la clave secreta de prueba de Cloudflare aprueba cualquier token). En unos segundos el poller envía los dos correos: abrir `http://localhost:8025` y ver "Recibimos tu solicitud ANT-2026-000001" y "Nueva solicitud ANT-2026-000001 · SEA". Detener la API al terminar. Anotar la salida en el reporte.

(`buildInvoiceXml` genera cuotas con vencimiento fijo; si en la fecha real de la prueba ese vencimiento ya pasó, la respuesta será 422 `INSTALLMENT_OVERDUE`: generar el XML con `installments` futuros, por ejemplo `buildInvoiceXml({ installments: [{ id: 'Cuota001', amount: '10620.00', dueDate: '<fecha a 60 días>' }] })`.)

- [ ] **Step 9: Verificar y commit**

Run: `pnpm --filter @anticipate/api exec vitest run --project api:unit && pnpm --filter @anticipate/api test:integration && pnpm --filter @anticipate/api typecheck && pnpm lint:fix && pnpm lint`
Expected: todo en verde.

```bash
git add apps/api
git commit -m "feat(api): recepción de solicitudes con turnstile, límites, reglas de shared y guardado atómico"
```

---

### Task 10: Imagen Docker de la API, CI de integración e imagen, documentación y STACK v0.8

**Files:**
- Create: `apps/api/Dockerfile`
- Modify: `apps/api/package.json` (`files`), `.github/workflows/ci.yml`, `README.md`, `docs/STACK.md`

**Interfaces:**
- Consumes: la API completa (Tareas 4 a 9), el servicio `api` del perfil de Compose (Tarea 1), el `.dockerignore` (Tarea 1).
- Produces: la imagen `runtime` (la misma que correrá en el hosting, STACK §12), la etapa `migrate` para `prisma migrate deploy` como contenedor de un solo uso, los jobs `integration` e `image` de CI y STACK.md v0.8 con las decisiones D37 a D42.

- [ ] **Step 1: `files` en el paquete de la API**

`pnpm deploy` copia de cada paquete solo lo que su `files` declara (sin `files`, sigue el `.gitignore`, que excluye `dist`). En `apps/api/package.json`, después de `"type": "module",`:
```json
  "files": ["dist"],
```
El cliente de Prisma generado vive en `src/generated/prisma` como TypeScript y `nest build` lo compila a `dist/generated/prisma`, así que viaja dentro de `dist`. Comprobar que `@prisma/client`, `@prisma/adapter-pg`, `pg`, `@aws-sdk/*`, `nodemailer`, `@anticipate/emails` y `@anticipate/shared` están en `dependencies` y `prisma` en `devDependencies`: la imagen se arma con `--prod`.

- [ ] **Step 2: El Dockerfile**

`apps/api/Dockerfile`:
```dockerfile
# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24.21.0-alpine3.24

# ---------- base: Node, y pnpm y turbo en las versiones del repositorio (sin corepack) ----------
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /repo
COPY package.json pnpm-workspace.yaml ./
# pnpm sale de `packageManager` y turbo del catálogo: cada versión tiene una sola fuente de verdad.
RUN npm install -g \
      "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")" \
      "turbo@$(sed -n 's/^  turbo: *[~^]*//p' pnpm-workspace.yaml)"

# ---------- pruner: el subconjunto del monorepo que necesita la API ----------
FROM base AS pruner
COPY . .
RUN turbo prune @anticipate/api --docker

# ---------- build: instala solo cuando cambian dependencias, compila y arma el runtime ----------
FROM base AS build
COPY --from=pruner /repo/out/json/ ./
COPY --from=pruner /repo/out/pnpm-lock.yaml /repo/out/pnpm-workspace.yaml ./
# El hook de git (lefthook) no aplica dentro de la imagen y falla sin .git.
RUN npm pkg delete scripts.prepare
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ ./
# turbo compila antes shared y emails (^build) y genera el cliente de Prisma (db:generate);
# `prisma generate` no se conecta a la base: prisma.config.ts tiene una URL de relleno.
RUN turbo run build --filter=@anticipate/api
# Runtime autocontenido: solo dependencias de producción, paquetes del workspace copiados (su dist).
RUN pnpm --filter @anticipate/api deploy --prod /out/api

# ---------- migrate: contenedor de un solo uso con el CLI de Prisma; nunca en el arranque de la API ----------
FROM build AS migrate
WORKDIR /repo/apps/api
CMD ["pnpm", "exec", "prisma", "migrate", "deploy"]

# ---------- runtime: sin devDependencies, sin CLI de Prisma, sin root ----------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
ENV PORT=4000
WORKDIR /app
COPY --from=build --chown=node:node /out/api ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/health || exit 1
CMD ["node", "dist/main.js"]
```

- [ ] **Step 3: Probar la imagen en local**

Run:
```bash
pnpm infra:up
docker build -f apps/api/Dockerfile --target migrate -t anticipate-api-migrate:local .
docker run --rm --network anticipate_default \
  -e DATABASE_URL=postgresql://anticipate:anticipate@postgres:5432/anticipate \
  anticipate-api-migrate:local
pnpm api:image
curl -fsS http://127.0.0.1:4000/health && echo
curl -fsS http://127.0.0.1:4000/payers && echo
docker compose exec api id -un
docker image ls anticipate-api:local --format '{{.Size}}'
docker compose --profile api down
```
Expected: la migración informa "No pending migrations to apply" (o aplica la inicial si la base estaba vacía); `/health` responde `{"status":"ok",…}` con `database` y `storage` en `up`; `/payers` responde la lista (con SEA si se corrió `pnpm db:seed`, o `[]`); el usuario es `node`; la imagen pesa menos de 300 MB. Anotar el tamaño en el reporte. Si `turbo prune` o `pnpm deploy` no se comportan como aquí (por ejemplo, `deploy` exige `injectWorkspacePackages` en esta versión de pnpm), corregir el Dockerfile y anotar el motivo; no cambiar la estructura de etapas.

- [ ] **Step 4: Jobs de CI**

Agregar a `.github/workflows/ci.yml`, después del job `verify` y con la misma indentación:
```yaml
  integration:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    env:
      LEFTHOOK: 0
      # Las mismas direcciones que apps/api/.env.test.example: los contenedores de Compose en el runner.
      DATABASE_URL_TEST: postgresql://anticipate:anticipate@127.0.0.1:5432/anticipate_test
      S3_ENDPOINT: http://127.0.0.1:9090
      S3_BUCKET: anticipate-local
      SMTP_HOST: 127.0.0.1
      SMTP_PORT: "1025"
      MAILPIT_API_URL: http://127.0.0.1:8025
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0 # turbo --affected necesita la historia para comparar con main
      - name: Levantar la infraestructura (la misma definición que en local)
        run: docker compose up -d
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with:
          node-version-file: .node-version
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Esperar a que los servicios estén sanos
        run: docker compose up -d --wait --wait-timeout 120
      - name: Tests de integración, solo lo afectado (pull request)
        if: github.event_name == 'pull_request'
        run: pnpm turbo run test:integration --affected
      - name: Tests de integración, todo (main)
        if: github.event_name != 'pull_request'
        run: pnpm turbo run test:integration
      - name: Logs de los contenedores
        if: failure()
        run: docker compose logs --no-color --tail=200
      - name: Bajar la infraestructura
        if: always()
        run: docker compose down -v --remove-orphans

  image:
    runs-on: ubuntu-latest
    timeout-minutes: 25
    steps:
      - uses: actions/checkout@v7
      - uses: docker/setup-buildx-action@v4
      - name: Construir la etapa de migraciones
        uses: docker/build-push-action@v7
        with:
          context: .
          file: apps/api/Dockerfile
          target: migrate
          load: true
          tags: anticipate-api-migrate:ci
          cache-from: type=gha
          cache-to: type=gha,mode=max
      - name: Construir la imagen de la API (no se publica)
        uses: docker/build-push-action@v7
        with:
          context: .
          file: apps/api/Dockerfile
          target: runtime
          load: true
          # El nombre del servicio `api` de Compose: `up --no-build` usa esta imagen.
          tags: anticipate-api:local
          cache-from: type=gha
      - name: Humo, migrar y arrancar la imagen real
        run: |
          docker compose up -d --wait --wait-timeout 120
          docker run --rm --network anticipate_default \
            -e DATABASE_URL=postgresql://anticipate:anticipate@postgres:5432/anticipate \
            anticipate-api-migrate:ci
          docker compose --profile api up -d --no-build --wait --wait-timeout 90
          curl -fsS http://127.0.0.1:4000/health
          test "$(curl -fsS http://127.0.0.1:4000/payers)" = "[]"
      - name: Logs de los contenedores
        if: failure()
        run: docker compose --profile api logs --no-color --tail=200
      - name: Bajar todo
        if: always()
        run: docker compose --profile api down -v --remove-orphans
```
El job `integration` reemplaza la "rama de Neon propia para los tests de la API" que STACK §12 preveía (D41): Neon se queda para staging y producción.

Run: `docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:1.7.13 -color`
Expected: sin errores (si la imagen de actionlint no está disponible, revisar la indentación a mano contra el job `verify`).

- [ ] **Step 5: README**

En `README.md`, agregar la sección "API" después de "Comandos":
```markdown
## API

`apps/api` es la API en NestJS. Para correrla en local:

1. `pnpm infra:up` (PostgreSQL, S3Mock y Mailpit en Docker).
2. `cp apps/api/.env.example apps/api/.env` y `cp apps/api/.env.test.example apps/api/.env.test` (si el puerto 5432 está ocupado, cambia `POSTGRES_PORT` en `.env` y las URL de ambos archivos).
3. `pnpm db:migrate && pnpm db:seed` (con `SEED_ADMIN_PASSWORD` en `apps/api/.env`).
4. `pnpm --filter @anticipate/api dev`: API en `http://localhost:4000`, documentación en `http://localhost:4000/docs` y correos en `http://localhost:8025`.

| Comando | Qué hace |
|---|---|
| `pnpm test:integration` | Tests contra los contenedores reales (base `anticipate_test`) |
| `pnpm api:image` | Construye la imagen de producción y la levanta con la infraestructura local |

`POST /advance-requests` recibe la solicitud (multipart: campo `form` con el JSON del formulario, archivos `xml` y `pdf`, token de Turnstile en la cabecera `x-turnstile-token`); el contrato completo está en `docs/STACK.md` (D38).
```
Y en "CI", agregar: "Además, el job `integration` corre los tests de integración contra Docker Compose y el job `image` construye la imagen de la API, aplica las migraciones y comprueba `/health`."

- [ ] **Step 6: STACK.md v0.8**

En `docs/STACK.md`:

(a) §8, reemplazar la lista "Flujo de creación de solicitud" (pasos 1 a 7) por:
```markdown
1. Rechazar por `Content-Length`, antes de leerlo, un cuerpo mayor al máximo (413) o sin tamaño declarado (411), y aplicar el límite de envíos por IP (429).
2. Verificar Turnstile con la cabecera `x-turnstile-token` antes de leer los archivos (403; 503 si Cloudflare no responde).
3. Leer el multipart en memoria con topes de cantidad y validar el campo `form` con el esquema de `shared` (400).
4. Con el pagador activo del `payerSlug`: leer cada XML y aplicar las reglas de factura (sección 9); validar cada PDF por contenido (`%PDF-`) y emparejarlo con su XML por nombre base; validar el monto pedido. Todos los problemas se responden juntos (422), cada uno con el archivo, la factura o el campo al que se refiere.
5. Descartar facturas que ya están en una solicitud viva (422) antes de subir nada.
6. Subir todos los archivos al almacenamiento en modo "todo o nada".
7. En una transacción: código público, proveedor (y representante legal si el contacto lo es y no existe con ese DNI), solicitud, archivos, facturas, consentimientos, historial inicial y los dos correos en `outbox_events`. El índice único parcial de facturas activas es la barrera final ante dos envíos simultáneos. Si la transacción falla, se borran los archivos subidos.
8. Responder `201` con el código de la solicitud. Los correos salen fuera de la petición (sección 10).
```

(b) §10, fila "Rutas" de la tabla de archivos:
```markdown
| Rutas | Facturas: `payers/{payerId}/advance-requests/{advanceRequestId}/invoices/{invoiceId}.{xml\|pdf}`. Documentos: `suppliers/{supplierId}/documents/{documentId}.{ext}`. Siempre ids (UUID validados), nunca slugs ni nombres de archivo del usuario |
```
y el párrafo que empieza "El módulo `storage` de la API ya está implementado" por:
```markdown
El módulo `storage` de la API (`StorageService`) expone `put`, `putAll` (todo o nada), `deleteQuietly`, `exists` y `downloadUrl` (5 minutos); `storageKeys` arma las rutas de la tabla. El SDK usa `WHEN_REQUIRED` en las sumas de verificación, que es lo que R2 y S3Mock aceptan.
```

(c) §10, en "Correos (Brevo)", reemplazar "detrás de una interfaz de envío con dos implementaciones: `brevo` para staging y producción, y `smtp` hacia Mailpit en local" por "detrás de una interfaz de envío con tres implementaciones: `brevo` para staging y producción, `smtp` hacia Mailpit en local y `fake` en memoria para los tests". Y el último párrafo (el del outbox) por:
```markdown
El envío no ocurre dentro de la petición. La misma transacción que guarda la solicitud inserta en `outbox_events` una fila por correo, con el evento de dominio `advance-request.created` de `shared` como contenido (patrón *transactional outbox*, D29 y D39). Un proceso del módulo `notifications` (scheduler de NestJS, cada pocos segundos) reclama filas pendientes cuyo `next_attempt_at` ya pasó con una sola sentencia atómica (`FOR UPDATE SKIP LOCKED`) y un arriendo (`locked_until`), envía fuera de toda transacción y marca `sent_at`; si falla, guarda `last_error` y programa el siguiente intento con espera exponencial y variación aleatoria. Un error permanente (por ejemplo, un 400 de Brevo) o el máximo de intentos dejan la fila en `FAILED`, visible en el admin. Si la API cae con filas en proceso, el arriendo vence y otra instancia las retoma; Brevo recibe el id de la fila como clave de idempotencia, así un reintento no duplica el correo. El mismo mecanismo sirve para WhatsApp en la fase 2, y si el volumen lo pide, el consumidor pasa a una cola externa sin cambiar nada más.
```

(d) §12, tabla de servicios: `postgres:17-alpine` → `postgres:17.11-alpine3.24`, `adobe/s3mock` (versión fijada) → `adobe/s3mock:5.2.3`, `axllent/mailpit` (versión fijada) → `axllent/mailpit:v1.31.2`. Tabla de comandos: agregar las filas `pnpm test:integration` ("Tests de la API contra los contenedores") y `pnpm api:image` ("Construye y levanta la imagen de producción de la API"). Fila "Imagen de la API": reemplazar "Se podrá levantar en local con un perfil de Compose para probar la imagen antes de publicarla" por "Se levanta en local con `pnpm api:image` (perfil `api` de Compose); las migraciones corren con la etapa `migrate` de la misma imagen o desde el workspace, nunca en el arranque". En "CI/CD", reemplazar "rama de Neon propia para los tests de la API" por "tests de integración de la API contra Docker Compose (la misma definición que en local) y construcción de la imagen con prueba de humo".

(e) §13, agregar después de D36:
```markdown
| D37 | Configuración de la API | Esquema Zod de todas las variables validado al arrancar; un objeto `AppConfig` tipado que se pasa a `AppModule.register(config)` | Si falta o sobra algo, la API no arranca y dice qué corregir; los tests arman su configuración sin tocar `process.env`; nada lee variables sueltas | `@nestjs/config` con `validate` (lee `process.env` en cualquier parte y deja el tipo en manos de cada consumidor) |
| D38 | Contrato de `POST /advance-requests` | `multipart/form-data`: campo `form` con el JSON del formulario, archivos `xml` (1 a N) y `pdf` (0 a N, emparejados por nombre base), Turnstile en la cabecera `x-turnstile-token`; 422 con todos los problemas juntos, cada uno con `file`, `invoice` o `field` | Los archivos viajan sin inflarse; Turnstile se verifica antes de leer los archivos; la landing marca cada problema en su fila | JSON con archivos en base64 (+33 % de peso, todo en memoria como texto); subida directa al bucket con URL firmada (STACK §10: se valida antes de guardar) |
| D39 | Detalle del outbox | Una fila por correo con el evento de dominio de `shared` como contenido; reclamo atómico con `FOR UPDATE SKIP LOCKED` y arriendo; espera exponencial con variación y tope; `FAILED` por error permanente o intentos agotados; clave de idempotencia de Brevo = id de la fila | Cada correo se reintenta por separado; dos instancias de la API no envían lo mismo; un reinicio no pierde ni duplica correos | Una fila por evento con reparto al enviar (un fallo de un destinatario reintenta a los dos); cola con Redis (infraestructura extra sin volumen que la justifique) |
| D40 | Prisma en la API | Prisma 7.10.0 fijado sin caret, generador `prisma-client` en `src/generated`, `@prisma/adapter-pg`, índice único parcial declarado en el esquema (`partialIndexes`) sobre la clave canónica `invoice_key` | La 8 está en pruebas; el índice en el esquema no se pierde en la próxima migración; la clave canónica iguala `F001-00000123` y `F001-123` | Prisma 8 RC; el índice solo en SQL a mano (el esquema lo borraría como deriva); índice sobre `(issuer_ruc, series_number)` crudos |
| D41 | Tests de la API en CI | Docker Compose en el runner, con la misma definición que en local | Mismo entorno que el equipo; sin secretos de Neon en pull requests; rápido y determinista | Rama de Neon por pull request (secretos en PR y latencia de red); `services:` de GitHub Actions (duplica la configuración de Compose) |
| D42 | Imagen de la API | `turbo prune` + `pnpm deploy --prod` sobre `node:24-alpine` fijado, sin root, con `HEALTHCHECK`; migraciones con la etapa `migrate` o desde el workspace, nunca en el `CMD` | La capa de dependencias se reutiliza mientras no cambie el lockfile; el runtime no lleva devDependencies ni el CLI de Prisma; migrar y arrancar son pasos distintos | Copiar el monorepo entero; `prisma migrate deploy && node dist/main.js` en el arranque |
```

(f) Historial, agregar la fila:
```markdown
| 0.8 | 2026-09-24 | Paso 2 (base de datos y API mínima): flujo de creación en el orden real de la API; rutas del almacenamiento en inglés; outbox con arriendo, reintentos y clave de idempotencia; versiones fijadas de la infraestructura local; tests de integración en CI con Docker Compose e imagen de la API con prueba de humo (D37 a D42) |
```
y cambiar la versión del encabezado del documento a 0.8.

- [ ] **Step 7: Verificación final y commits**

Run: `pnpm verify && pnpm test:integration && pnpm api:image && curl -fsS http://127.0.0.1:4000/health && docker compose --profile api down`
Expected: lint, tipos, tests unitarios de los tres paquetes y la API, build, los tests de integración y la imagen, todo en verde.

```bash
git add apps/api/Dockerfile apps/api/package.json .github/workflows/ci.yml
git commit -m "build(api): imagen docker multi-etapa y jobs de integración e imagen en ci"
git add README.md docs/STACK.md
git commit -m "docs: stack v0.8 y readme con la api, el entorno local y las decisiones del paso 2"
```

---

## Decisiones que este plan toma y que STACK.md no tenía escritas

| Tema | Decisión | Por qué |
|---|---|---|
| Configuración | Zod + `AppModule.register(config)`, sin `@nestjs/config` (D37) | Un objeto tipado y validado; los tests arman el suyo |
| Contrato del envío | Multipart con `form` JSON, `xml` y `pdf` por nombre base, Turnstile en cabecera (D38) | Turnstile antes de leer archivos; archivos sin base64 |
| Orden de las barreras | `Content-Length` → límite por IP → Turnstile → multer → `form` → reglas → duplicados → subida → transacción | Cada barrera descarta lo más barato primero; nada se sube si algo falla |
| Problemas por archivo | `Problem.file` en `shared` | La landing marca la fila exacta, incluso de un XML ilegible sin serie-número |
| Tope por archivo | Lo revisa el servicio (422 con el nombre), no multer (413 genérico) | El cuerpo ya está acotado por `Content-Length`; el usuario sabe qué archivo achicar |
| Facturas repetidas | Verificación previa + índice único parcial como barrera final | La previa evita subir en vano; el índice resuelve la carrera entre dos envíos |
| Archivos antes de la transacción | Subida todo o nada y borrado si la transacción falla | La transacción no queda abierta durante la red; no quedan huérfanos |
| Proveedor y representante existentes | `upsert` sin actualizar | Lo que el admin corrigió no se pisa desde la landing |
| Outbox | Una fila por correo, arriendo, espera exponencial con variación, `FAILED` (D39) | Reintentos independientes, sin envíos dobles entre instancias ni tras reinicios |
| Prisma | 7.10.0 fijo, índice parcial en el esquema, clave canónica `invoice_key` (D40) | 8 en pruebas; sin deriva de migraciones; `F001-0123` ≡ `F001-123` |
| Reloj inyectable | `CLOCK` en toda la API | Tests deterministas de fechas de Lima, vencimientos y reintentos |
| App de pruebas | `Test.createTestingModule` + el mismo `configureApp` de producción | Se prueba la configuración real; `src` no importa `@nestjs/testing` |
| CI de la API | Docker Compose en el runner (D41) | Mismo entorno que en local, sin secretos en pull requests |
| Imagen | `turbo prune` + `pnpm deploy --prod`, sin root, migraciones aparte (D42) | Capas cacheables, runtime mínimo, migrar no es arrancar |
| Servicio `api` de Compose | Variables en línea, sin `env_file` | `infra:up` no depende de un archivo local que no todos tienen |

## Self-review (hecho al escribir el plan)

- **Cobertura de STACK.md**: §8 módulos `config`, `prisma`, `pagadores`, `facturas`, `storage`, `notificaciones`, `health` y el flujo de creación completo (Tareas 4 a 9); `solicitudes` solo con la creación (la bandeja y los cambios de estado van con el admin, paso 4); §9 las 13 tablas, enums, índice parcial y secuencia del código (Tarea 5); §10 rutas del almacenamiento, correos y outbox (Tareas 3, 6 y 8); §11 Turnstile, límites, tope de bytes, validación por contenido, IP real, CORS y logs sin datos sensibles (Tareas 4 y 9); §12 entorno local, imagen y CI (Tareas 1 y 10). Fuera de este plan, a propósito: `auth`, `usuarios`, `seguimientos`, `auditoria` y los endpoints `/admin/*` (paso 4), la landing conectada a la API (paso 3), despliegue a staging y producción.
- **Placeholders**: ninguno en el código. Los únicos datos por completar son los reales de SEA (RUC, porcentaje, plazo mínimo y máximo de facturas), que el seed marca como de ejemplo y se cambian en la base sin tocar código, y la contraseña del admin del seed, que se pide por variable de entorno.
- **Consistencia de nombres**: `parseConfig`, `AppConfig`, `APP_CONFIG`, `CLOCK`, `ProblemsException`, `resolveClientIp`, `SubmitThrottle`, `PrismaService`/`Tx`, `isUniqueViolation`, `storageKeys`, `StorageService.putAll`/`deleteQuietly`, `PayerRecord`/`buildValidationContext`, `OutboxService.enqueue`, `OutboxProcessor.drain`, `FakeMailSender`, `TURNSTILE_VERIFIER`, `createTestApp`, `truncateAll` y `createPayer` se usan con la misma firma en todas las tareas; los nombres de `shared` (`createProblem`, `validateInvoices`, `validateRequestedAmount`, `invoiceKey`, `formatPublicCode`, `advanceRequestCreatedEventSchema`, `buildInvoiceXml`) se revisaron contra el código de `packages/shared` el 2026-09-24.
- **Review Focus**: (1) dos envíos simultáneos, Tarea 9, "dos envíos simultáneos con la misma factura"; (2) transacción que falla tras subir, Tarea 9, "si la transacción falla, no quedan archivos huérfanos" (trigger de prueba en `consents`); (3) cuerpo de 200 MB y XML de 2 MB, Tarea 9, "un cuerpo mayor al máximo: 413" y "un XML o un PDF mayor a su tope" (con topes bajados por configuración); (4) Brevo 429/500, Tarea 8, reintentos con espera y `FAILED` al agotar; (5) reinicio con filas en `PROCESSING`, Tarea 8, arriendo vencido y retoma sin reenviar lo `SENT`.
- **Riesgos conocidos para quien ejecute**: APIs de librerías recién publicadas (NestJS 12.1, Prisma 7.10, Vitest 5, pnpm 12.6) se verificaron contra documentación y pruebas propias el 2026-09-24, pero una firma distinta se corrige sin cambiar lo que prueban los tests y se anota en el reporte. Los puntos más probables: el `meta` de P2002 con el adaptador de PostgreSQL (`isUniqueViolation` lo busca en todo el `meta`), el `Content-Length` de supertest en multipart y el comportamiento de `pnpm deploy` con catálogos.
