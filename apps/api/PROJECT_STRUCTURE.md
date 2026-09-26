# Estructura de `apps/api`

La API de Anticipate Factoring es una app NestJS 12 en ESM, organizada en módulos por capas con puertos,
casos de uso, mappers, constantes y excepciones. Las reglas de negocio no viven aquí: están en
`@anticipate/shared`, que comparten la landing, el admin y la API. `src/architecture.test.ts` hace cumplir
las reglas de dependencia de este documento: si el documento y el test difieren, manda el test y se corrige
el documento.

## Árbol

El árbol es el del paso 2 completo. No se crean carpetas vacías: cada carpeta aparece con su primer archivo.

```text
apps/api/
├── package.json · nest-cli.json · tsconfig.json · tsconfig.build.json · vitest.config.ts
├── .env.example · .env.test.example · prisma.config.ts · Dockerfile
├── prisma/               schema.prisma, migrations/ y seed.ts
├── src/
│   ├── main.ts · app.module.ts · app.setup.ts · architecture.test.ts
│   ├── bootstrap/        contrato HTTP de la app: prefijo, versión, helmet, CORS, parser de JSON,
│   │                     tiempos del servidor, logger HTTP y Swagger
│   ├── common/           transversal sin dueño: config, constants, decorators, guards, middleware,
│   │                     time, types, utils, exceptions, filters, interceptors, swagger,
│   │                     validation, storage y captcha
│   ├── infrastructure/   adaptadores: time, prisma (y sus repositories/), storage/s3, notifications
│   │                     y captcha/turnstile
│   ├── modules/          health-checks, payers, notifications, outbox, advance-requests y maintenance
│   └── workers/          raíces de composición en segundo plano: outbox-publisher y maintenance
└── test/
    ├── integration/      global-setup.ts y los *.test.ts contra los contenedores reales
    └── support/          config.ts, app.ts, fakes.ts, db.ts, factories.ts, s3.ts, mailpit.ts y
                          advance-request-fixtures.ts
```

## Qué va en cada lugar

| Carpeta | Contenido | No contiene |
|---|---|---|
| `src/` (raíz) | `main.ts` (lee `.env` fuera de producción, valida la configuración, crea la app y abre el puerto), `app.module.ts` (`AppModule.register(config, extraModules)`, la raíz de composición) y `app.setup.ts` (`NEST_APP_OPTIONS` y `setupApp`, compartidos por producción y tests) | Lógica de negocio |
| `bootstrap/` | Una pieza por archivo: `constants.ts` (`API_PREFIX`, `API_DEFAULT_VERSION`, `SWAGGER_PATH`, `HEALTH_PATHS`), `body-parser.options.ts`, `cors.options.ts`, `helmet.options.ts`, `server-timeouts.ts`, `pino-http.options.ts`, `swagger.setup.ts` y `startup-banner.ts` (las líneas de arranque: URL completas fuera de producción) | Nada de `modules/` |
| `common/` | Lo transversal: configuración validada, cabeceras del contrato, decoradores, guards, middleware, puertos comunes (`Clock`, almacenamiento, captcha), excepciones, filtro, interceptores y validación | Nada de `modules/`, `infrastructure/` ni `workers/` |
| `infrastructure/` | Adaptadores de los puertos: Prisma y sus repositorios (`prisma/repositories/<módulo>/`, con su módulo de persistencia y sus `mappers/`), S3, correo, Turnstile y reloj | Casos de uso, controladores, workers |
| `modules/<m>/domain/` | TypeScript puro: tipos, servicios de dominio y errores del módulo | Nest, Prisma, Express, adaptadores |
| `modules/<m>/application/` | Puertos (`ports/*.port.ts`, con su token `Symbol`), casos de uso, servicios de aplicación, handlers y tipos. Clases con dependencias por constructor | Nest, Prisma, Express, multer, AWS SDK, nodemailer, `infrastructure/` |
| `modules/<m>/presentation/http/` | Controladores, pipes, decoradores, DTO de multipart, mappers de respuesta, Swagger y `constants/` del módulo (por ejemplo, `payers/presentation/http/constants/public-payers.constants.ts`: `PUBLIC_PAYERS_CACHE_CONTROL`, caché pública de `GET /api/v1/payers`) | Repositorios o adaptadores |
| `modules/<m>/<m>.module.ts` | Cableado: cada clase de `application/` se provee con `useFactory` + `inject` contra tokens | Lógica |
| `modules/<m>/index.ts` | La frontera pública del módulo: lo que otros módulos, la infraestructura y los workers pueden usar | Reexportar todo por comodidad |
| `modules/health-checks/` | Módulo plano, sin capas: `health-checks.module.ts`, `controllers/health.controller.ts` e `index.ts`. Las rutas de las sondas salen de `bootstrap/constants.ts` (`HEALTH_PATHS`) | Sobre de respuesta |
| `workers/<w>/` | Raíces de composición de los procesos periódicos: su módulo y su scheduler | Flujos de negocio propios (llaman casos de uso) |

### Carpetas de `common/`

| Carpeta | Archivos | Para qué |
|---|---|---|
| `config/` | `schemas/<tema>.schema.ts`, `schemas/env-values.ts`, `environment.schema.ts`, `app-config.ts`, `app-config.module.ts`, `index.ts` | Configuración validada (`APP_CONFIG`) |
| `constants/` | `http-headers.constants.ts` | Nombres de las cabeceras del contrato HTTP |
| `decorators/` | `submit-throttle.decorator.ts`, `response-message.decorator.ts`, `skip-response-envelope.decorator.ts` | Metadatos de ruta que leen el guard y el interceptor |
| `guards/` | `app-throttler.guard.ts` | Límites de peticiones por IP real (`APP_GUARD`) |
| `middleware/` | `correlation-id.middleware.ts`, `content-length-limit.middleware.ts`, `body-parser-error.middleware.ts` (errores de body-parser con su tipo, para `AllExceptionsFilter`), `index.ts` | Piezas de Express que corren antes de los guards |
| `time/` | `clock.ts` | Puerto `Clock` y token `CLOCK` |
| `types/` | `express.d.ts`, `paginated-list.ts` | `Request.correlationId` y listas paginadas |
| `utils/` | `client-ip.ts`, `correlation-id.ts`, `build-pagination-meta.ts`, `uuid.ts` | Utilidades genéricas que usan dos partes o más |
| `exceptions/` | `application-error.ts` y los errores de la aplicación, `index.ts` | Errores con código público, sin Nest |
| `filters/` | `all-exceptions.filter.ts`, `default-http-error-code.map.ts`, `exception-translator.ts` (tipo `ExceptionTranslator` y token `EXCEPTION_TRANSLATORS`), `index.ts` | Todo error sale con el sobre de error (`APP_FILTER`) |
| `interceptors/` | `response-envelope.interceptor.ts`, `multipart-files.interceptor.ts` | Sobre de éxito (`APP_INTERCEPTOR`) y multipart |
| `swagger/` | `api-enveloped-response.swagger.ts`, `api-error-responses.swagger.ts` | Documentación del sobre y de los errores |
| `validation/` | `validation-exception.factory.ts` | Violaciones de validación agrupadas por campo |
| `storage/` | `file-storage.port.ts`, `index.ts` | Puerto del almacenamiento de archivos (`FILE_STORAGE`) |
| `captcha/` | `captcha-verifier.port.ts`, `captcha.guard.ts`, `index.ts` | Puerto del captcha (`CAPTCHA_VERIFIER`) y su guard |

Reglas de forma:

- No se crean carpetas vacías. `index.ts` solo en las fronteras del árbol (`common/config`, `common/middleware`,
  `infrastructure/time`, `modules/<m>`). No existe `common/index.ts`.
- Dentro de una carpeta los imports apuntan al archivo concreto, nunca al barril de una carpeta que contiene al
  propio archivo.
- `common/utils` es solo para utilidades genéricas que usan dos partes o más.
- Los tests unitarios son `*.test.ts` junto al código; los de integración viven en `test/integration/`.

## Imports

- Los imports internos que cruzan de zona usan subpath imports de Node: `#/common/config/index.js`. En
  `package.json`, `"imports": { "#/*": { "@anticipate/source": "./src/*", "default": "./dist/*" } }`. TypeScript
  (`customConditions`) y Vitest (`ssr.resolve.conditions`) leen `src`; Node, en producción, lee `dist`. Un
  script con `tsx` que importe código de la app corre con `tsx --conditions=@anticipate/source`. Nunca `paths`
  de tsconfig.
- Un import relativo nunca sale de su zona: `modules/<m>`, `common/<x>`, `infrastructure/<x>`, `workers/<w>`,
  `bootstrap` o la raíz de `src`.
- De los paquetes del monorepo, la API solo importa `@anticipate/shared` (por subruta: `@anticipate/shared/dates`)
  y `@anticipate/emails`.

## Reglas de dependencia

Cada archivo de `src` (salvo `infrastructure/prisma/generated/` y los `*.test.ts`) tiene una capa según su ruta.

| # | Capa | Puede importar |
|---|---|---|
| 1 | `domain` | su `domain`, `common/exceptions`, `@anticipate/shared/*`, `node:crypto` |
| 2 | `application` | su `domain` y su `application`; otro módulo solo por `modules/<x>/index.ts`; de `common`, solo `exceptions`, `time/clock.ts`, `storage` (puerto) y `captcha/captcha-verifier.port.ts`; `@anticipate/shared/*`, `@anticipate/emails` |
| 3 | `presentation` | sus casos de uso y tipos (no los puertos), su `domain`, `common/**`, `@nestjs/*`, `express`, `@anticipate/shared/*` |
| 4 | `module-wiring` (`modules/*/*.module.ts`, `modules/*/index.ts`) | su módulo, el `index.ts` de otro módulo, `common/**`, `infrastructure/**` (solo para cablear), `@nestjs/*` |
| 5 | `infrastructure` | `common/**`, `infrastructure/**`, `modules/*/index.ts`; cualquier paquete salvo la regla 6 |
| 6 | Dependencias técnicas | `@prisma/*` y `infrastructure/prisma/generated/**` solo desde `infrastructure/prisma/**`; `@aws-sdk/*` solo desde `infrastructure/storage/**`; `nodemailer` solo desde `infrastructure/notifications/**`; `uuid` solo desde `infrastructure/prisma/id.ts` |
| 7 | `workers` | su carpeta, `modules/*/index.ts`, `infrastructure/**/*.module.ts`, `infrastructure/*/index.ts`, `common/**`, `@nestjs/*` |
| 8 | `common` | `common/**`, `@nestjs/*`, `express`, `multer`, `@anticipate/shared/*`, `rxjs`, `node:*`, `helmet`, `zod` |
| 9 | `bootstrap` | `bootstrap/**`, `common/**`, `@nestjs/*` y los paquetes de arranque (`helmet`, `nestjs-pino`, `pino`, `pino-http`, `express`, `node:*`) |
| 10 | `health-checks` | su carpeta, `bootstrap/constants.ts` (las rutas de las sondas), `common/**`, `infrastructure/**` (indicadores), `modules/*/index.ts`, `@nestjs/*` |
| — | `root` | todo, salvo la regla 6 |

Además, Biome prohíbe importar `randomUUID` (y el import por defecto o de namespace de `node:crypto`) en
`src/**`, salvo en `common/utils/correlation-id.ts`: las claves primarias son UUIDv7 y salen de `newId()`
(`infrastructure/prisma/id.ts`).

Agregar una capa o un permiso es una línea en la tabla `POLICIES` de `architecture.test.ts`, con su caso de
violación en el mismo archivo.

## Configuración

- `common/config/schemas/<tema>.schema.ts` declara las variables de un tema (runtime, http, database, storage,
  mail, captcha, upload, throttle, outbox, maintenance), sus valores por defecto y sus reglas cruzadas, con las
  guardas de producción. `environment.schema.ts` los junta y `parseConfig` devuelve el `AppConfig` congelado o
  lanza `ConfigValidationError` con todos los problemas en español, sin repetir ningún valor.
- La configuración no usa `@nestjs/config`: `main.ts` y los tests arman su `AppConfig` y
  `AppModule.register(config)` la provee como `APP_CONFIG`.
- Para agregar una variable: su esquema, `.env.example` (el test exige que declare exactamente las claves del
  esquema, más las del seed), `TEST_ENV_DEFAULTS` de `test/support/config.ts` (no compila si falta) y el test
  del tema en `app-config.test.ts`.
- Los tests de integración toman las URLs de los contenedores solo de `apps/api/.env.test` (copia de
  `.env.test.example`): `test/integration/global-setup.ts` lo lee y lo entrega a `testEnv` con
  `provide`/`inject` de Vitest. Una variable exportada en la terminal nunca llega a los tests.

## Decisiones de forma

| Tema | Decisión | Por qué |
|---|---|---|
| Módulos | ESM (`"type": "module"`), imports con `.js` | NestJS 12 y el resto del monorepo son ESM |
| Imports internos | Subpath imports `#/*` con la condición `@anticipate/source` | `#/` lo resuelve Node en `dist` y TypeScript y Vitest en `src`, sin bundler, sin alias y sin `paths` |
| Configuración | Zod por tema, congelada, con guardas de producción | Cada test arma la suya sin tocar `process.env`; las reglas cruzadas viven con su tema |
| Validación de entrada | `StandardSchemaValidationPipe` con los esquemas Zod de `shared` | Un solo esquema para landing, admin y API |
| Tests | Vitest 5 sin SWC; unitarios junto al código, integración en `test/integration` contra Docker Compose | La herramienta del monorepo |
| Fronteras | `src/architecture.test.ts` con un caso de violación por regla, más Biome | Biome no tiene reglas de fronteras por carpeta |
| Id de correlación | `x-correlation-id` con `^[A-Za-z0-9._-]{1,128}$`, resuelto una vez en `req.correlationId` | El mismo valor lo usan pino, el filtro, el interceptor, la solicitud y el outbox |
| Límite de peticiones | `default` en toda ruta y `submit` en las rutas con `@SubmitThrottle()`, por IP real (`CF-Connecting-IP` si se confía en Cloudflare), IPv6 por /64, con `Retry-After` | El único endpoint de escritura es público |
| Parser del cuerpo | Solo JSON de 256 KB; el multipart tiene su tope por `Content-Length`, revisado antes de leer el cuerpo | La API no recibe formularios `urlencoded` ni JSON grandes |
| Tiempos del servidor | `setupApp` los fija, también en los tests | Los tests prueban la misma configuración que producción |
| Swagger | En `/docs` fuera de producción (`development` y `test`) | Los tests verifican el documento |
| Puertos y repositorios | Puertos en `application/ports/` con token `Symbol`; repositorios en `infrastructure/prisma/repositories/<módulo>/`; cableado con `useFactory` | `application/` queda libre de Nest y de Prisma |
| Ids | UUIDv7 con `newId()` (`infrastructure/prisma/id.ts`); Biome prohíbe `randomUUID` fuera del id de correlación | El orden por `id` es el orden de creación |
| Errores de infraestructura | Cada adaptador publica un `ExceptionTranslator` (`translateDatabaseException` en `infrastructure/prisma`) y `app.module.ts` los entrega a `AllExceptionsFilter` con `EXCEPTION_TRANSLATORS` | La base caída es 503 en toda ruta sin que cada caso de uso la envuelva, y `common` no conoce Prisma |
