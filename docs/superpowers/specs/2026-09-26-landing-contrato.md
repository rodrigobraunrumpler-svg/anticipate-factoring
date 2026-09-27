> Copia del contrato de diseño con el que se escribe el plan del paso 3. Las rutas `SCRATCH/...` eran del directorio temporal de la sesión; su contenido (tableros del diseño, investigación y borrador del plan) está en `.superpowers/sdd/2026-09-26-landing-de-proveedores/`, fuera de git.

# Contrato de diseño del paso 3 · Landing de proveedores en el monorepo

Versión 1.1 · 2026-09-26. Fuente de verdad para escribir el plan del paso 3. Manda sobre STACK v0.8 donde difieran; la Tarea 15 lleva STACK a v0.9 con las decisiones D60 a D70 de la sección 8.

Rutas cortas usadas abajo: `SCRATCH` = `/tmp/claude-1000/-home-javier-anticipate-projects-anticipate-factoring/23707d3d-cf6f-4fc3-bc74-96e0b42ded46/scratchpad`; `REPO` = `/home/javier/anticipate-projects/anticipate-factoring`.

## 0. Fuentes (léelas antes de escribir)

- **Diseño aprobado**: artefacto https://claude.ai/artifact/QYRjWPXEPQx1ixVksjhDmR, versión 16. Copia local en `SCRATCH/landing-design/project/`:
  - `Main.dc.html` (escritorio 1440);
  - `Mobile.dc.html` y `MobileForm.dc.html` (móvil 390);
  - `MobileExtras.dc.html` (menú abierto, barra fija neutra y "Continuar", pasos fijos en el formulario);
  - `Estados.dc.html` (los 8 estados del formulario).
  Son HTML con estilos en línea, `{{huecos}}`, `sc-for`/`sc-if` y una clase `DCLogic` con los datos de ejemplo. El texto de los tableros es el texto final de la landing, y el plan lo copia tal cual. Colores, medidas, tipografía y espaciados salen de ahí.
- **STACK v0.8** (`REPO/docs/STACK.md`): §4, §5, §6 (landing), §8 (API), §11 (seguridad), §12 (entornos y despliegue), §13 (decisiones D1–D59) y §14 (pendientes).
- **Investigación verificada en laboratorios** (JSON con `summary`, `verifiedFacts`, `recommendations`, `risks` y `openQuestions`):
  - `SCRATCH/research-api-contract.json`: contrato con la API, probado en vivo.
  - `SCRATCH/research-astro-monorepo.json`: Astro 7 en el monorepo. Lab en `SCRATCH/step3-lab/astro-monorepo/`.
  - `SCRATCH/research-browser-xml.json`: lector en el navegador, worker, .zip, borrador y normalizadores. Lab en `SCRATCH/step3-lab/form-logic/`: `paste/normalize.ts` y su test, `pipeline/zip-extract.ts`, `pipeline/worker.ts`.
  - `SCRATCH/research-quality-deploy.json`: pruebas, CI, CSP, Turnstile y despliegue. Lab en `SCRATCH/step3-lab/quality-deploy/`.
  El código de los labs es base reutilizable: el plan lo adapta al repo y lo escribe completo.
- **Planes anteriores**: `REPO/docs/superpowers/plans/2026-09-23-fundaciones-y-shared.md` y `REPO/docs/superpowers/plans/2026-09-24-base-de-datos-y-api-minima.md`. Dan el formato, el estilo y las Global Constraints que se heredan.
- **Código que hay que leer si se toca**:
  - `REPO/packages/shared/src/**`: lector UBL, reglas, `testing/build-test-xml.ts`, `api/intake-limits.ts`, `advance-request/form.ts` y `architecture.test.ts`.
  - `REPO/apps/api/src/modules/{payers,advance-requests}/**` y `REPO/apps/api/prisma/seed.ts`.
  - `REPO/packages/emails/src/**`.
  - `REPO/turbo.json`, `REPO/biome.json`, `REPO/pnpm-workspace.yaml`, `REPO/.github/workflows/ci.yml`, `REPO/docker-compose.yml` y `REPO/docker/postgres/init/01-create-databases.sh`.

## 1. Reglas que se heredan del paso 2

- **Idioma**: identificadores, rutas, archivos y códigos en inglés. Todo texto para personas en español: textos de la landing, mensajes, comentarios, documentación y commits.
- **Commits**: una sola línea en español con Conventional Commits, cabecera de hasta 100 caracteres, sin cuerpo, sin trailers y sin `Co-Authored-By`. Nunca `--no-verify`. Cada tarea termina con un commit (`git commit -m "…"`).
- **Reglas de negocio solo en `@anticipate/shared`**: la landing no reimplementa reglas de factura, dinero, identidad ni validación del formulario, sino que las importa. Si falta algo, se agrega a `shared` con su test. `shared` sigue sin imports de `node:` ni de `Buffer`, lo que hace cumplir su `architecture.test.ts`.
- **Versiones**: todas en el `catalog` de `pnpm-workspace.yaml` (`catalogMode: strict`), y los `package.json` usan `catalog:`. Con `minimumReleaseAge: 1440`, se fija la versión que pnpm resuelve de verdad. Versiones verificadas el 2026-09-26:

  | Paquete | Versión |
  |---|---|
  | `astro` | ^7.3.5 |
  | `@astrojs/react` | ^7.0.0 |
  | `@astrojs/check` | ^0.9.10 |
  | `@astrojs/sitemap` | ^3.7.4 |
  | `react`, `react-dom`, `@types/react`, `@types/react-dom` | ^19.3.0 |
  | `vite` | ^8.3.0 |
  | `@fontsource-variable/archivo` | ^5.3.0 |
  | `fflate` | ^0.8.3 |
  | `idb-keyval` | ^6.3.0 |
  | `@playwright/test` | ^1.63.0 |
  | `@axe-core/playwright` | ^4.13.0 |
  | `jsdom` | ^30.1.1 |
  | `@testing-library/react` | ^16.3.3 |
  | `@testing-library/dom` | ^10.4.2 |
  | `@testing-library/user-event` | ^14.6.7 |
  | `@testing-library/jest-dom` | ^7.0.1 |
  | `wrangler` | ^4.141.0 |
  | `satori` | ^0.33.5 |
  | `@resvg/resvg-js` | ^2.6.2 |

  Además, `workerd: true` en `allowBuilds`. Sin `react-hook-form` ni `@marsidev/react-turnstile` (sección 4.6).
- **Dinero**: siempre `Amount` (texto con dos decimales) y las funciones de `shared/money`. Nunca un `number` para un monto.
- **Fechas**: las de negocio son `IsoDate`, y "hoy" sale de `todayIn(LIMA_TIME_ZONE, new Date())`. El reloj del dispositivo solo orienta: la API manda.
- **Puertos de esta máquina**:

  | Servicio | Puerto |
  |---|---|
  | PostgreSQL | 5433 |
  | API de desarrollo | 4001 |
  | S3Mock | 9090 |
  | Mailpit | 1025 / 8025 |
  | Landing con `astro dev` (ya está en `CORS_ORIGINS` de desarrollo) | 4321 |
  | API del E2E | 4010 |
  | Landing del E2E con `wrangler dev` | 8788 |

  Nunca 5432, 4000, 4566 ni 6379. Los valores por defecto de las plantillas que usa CI son los de Compose, como en el paso 2.
- **Prohibido sin permiso del usuario**:
  - `pnpm infra:reset`, `docker compose down -v`, `prisma migrate reset` y `docker system prune`;
  - escribir en la base de desarrollo `anticipate`, salvo `migrate deploy` de migraciones nuevas y `pnpm db:seed` en la Tarea 3;
  - peticiones destructivas o a nivel de bucket en `anticipate-local` (subir objetos sí se permite);
  - vaciar Mailpit;
  - agregar `.vscode/settings.json` a un commit.
  Crear la base `anticipate_e2e` en el PostgreSQL de Compose está permitido (Tarea 15).
- **Astro 7 bajo un agente de IA**: `astro dev` se va a segundo plano. Los pasos del plan usan `astro dev --ignore-lock` o cierran con `astro dev stop`. La telemetría va apagada: `ASTRO_TELEMETRY_DISABLED=1` y `WRANGLER_SEND_METRICS=false`, en los scripts, en turbo `globalPassThroughEnv` y en CI.
- **Otros repositorios**: ninguno se usa como referencia.

## 2. Tareas

| # | Tarea | Deja listo | Rigor |
|---|---|---|---|
| 1 | `@anticipate/shared/intake` | emparejado de PDF, filtro de nombres, lectura de XML y contexto de validación movidos desde la API; agrupado de facturas por moneda y emisor | datos: una ronda |
| 2 | Normalizadores y ayudas para personas en shared | entrada pegada (monto, celular, DNI, RUC, correo), `formatMoney`, UTM y referrer, frases de horario, datos de contacto de Anticipate | un revisor |
| 3 | API para la landing | `GET /api/v1/legal-documents`, cupo de envíos por defecto 20 por hora, seed con los datos reales de SEA que actualiza, humo de CI ampliado | datos: una ronda |
| 4 | Correo de confirmación completo | la copia al proveedor dice desde qué número y en qué horario lo llamamos, qué sigue, WhatsApp y soporte; montos con `formatMoney` | un revisor |
| 5 | `apps/landing`: base Astro | app, configuración, turbo, Biome, entorno validado, datos del build con fallo cerrado, modo fixtures explícito, layout con fuente y tokens, páginas `/[payer]`, `/` y 404 | un revisor |
| 6 | Secciones estáticas | cabecera y menú móvil, hero, beneficios, cómo funciona, requisitos, dónde está el XML, preguntas, franja final y pie, en escritorio y móvil | un revisor |
| 7 | Lectura de facturas en el navegador | worker con lector y .zip, protocolo, estado de admisión puro, textos por problema | datos: una ronda |
| 8 | Calculadora | isla con monto discreto, moneda, pegar tolerante, subida de XML y traspaso al formulario | un revisor |
| 9 | Formulario, paso 01 | lista de facturas, agregar, quitar con deshacer, PDF, estados que no bloquean, grupos, topes y Cavali | un revisor |
| 10 | Formulario, pasos 02 y 03 y cierre | monto, motivo opcional, datos, representante, horario, ficha de confianza, resumen, consentimientos, aviso por capas y pasos por avance | un revisor |
| 11 | Envío y confirmación | Turnstile, cliente XHR, idempotencia por huella, tabla de respuestas, marcado de problemas, confirmación y modo demostración | seguridad: una ronda |
| 12 | Borrador en el dispositivo | IndexedDB con idb-keyval, 72 h, "Seguimos donde te quedaste", "Empezar de nuevo" y "No guardar en este dispositivo" | datos: una ronda |
| 13 | Comportamiento móvil | barra fija neutra y "Continuar", oculta en el formulario y con el teclado, pasos fijos, `scroll-margin-top` | un revisor |
| 14 | SEO, cabeceras y despliegue | metadatos y OG por pagador, sitemap, robots, CSP y cabeceras, `_redirects`, `wrangler.jsonc`, Web Analytics opcional, protección ante chunks viejos, flujo de despliegue | seguridad: una ronda |
| 15 | E2E, CI y documentación | Playwright contra la API real en `anticipate_e2e`, axe, job `e2e`, `verify` con fixtures y `wrangler deploy --dry-run`, README, STACK v0.9 y bitácora | un revisor |

Tabla de propiedad (quién crea o modifica cada cosa):

- **T1**:
  - Crea `packages/shared/src/intake/**`.
  - Modifica `packages/shared/package.json` (export `./intake`), `packages/shared/tsdown.config.ts` y `packages/shared/src/architecture.test.ts` (fila `intake`), y la línea `dev` de `packages/shared/package.json` (pasa a `tsdown --watch --no-clean`).
  - En la API: `apps/api/src/modules/advance-requests/domain/services/{pdf-pairing,file-names,xml-reading,validation-context}.ts` y sus tests se borran, y los que los importan pasan a `@anticipate/shared/intake`. También cambia `apps/api/src/modules/advance-requests/domain/types/invoice-intake.types.ts`.
- **T2**:
  - Crea `packages/shared/src/text/pasted.ts`, `money/amount-input.ts`, `money/format.ts`, `identity/mobile.ts`, `advance-request/source.ts` y `company/**` (export nuevo `./company`).
  - Modifica `identity/dni.ts`, `identity/ruc.ts`, `advance-request/form.ts` (usa `mobileSchema` de `identity` y agrega `CONTACT_TIME_SLOT_PHRASES`), los índices, `architecture.test.ts` y `package.json` (export `./company`), además de sus tests.
- **T3**:
  - Crea `apps/api/src/modules/legal-documents/**` y `apps/api/src/infrastructure/prisma/repositories/legal-documents/**`, y el esquema de respuesta en `packages/shared/src/api/legal-documents.ts` (export desde `./api`).
  - Modifica `apps/api/src/app.module.ts`, el esquema del throttle con `.env.example` y `.env.test.example`, y `apps/api/prisma/seed.ts`.
  - Agrega `apps/api/test/integration/legal-documents.test.ts` y el paso de humo del job `image` en `.github/workflows/ci.yml`.
- **T4**: `packages/emails/src/**` (plantillas y tests) y lo que la API arma para esos correos (`apps/api/src/modules/advance-requests/**` handlers y mappers de datos del correo, con sus tests).
- **T5**:
  - Crea `apps/landing/{package.json, astro.config.ts, tsconfig.json, vitest.config.ts, .env.example, src/env.d.ts, src/lib/build-data/**, src/lib/api/envelope.ts, src/layouts/BaseLayout.astro, src/styles/{tokens.css,global.css}, src/pages/[payer].astro, src/pages/index.astro, src/pages/404.astro}`.
  - En la raíz modifica `turbo.json`, `biome.json` (`html.experimentalFullSupportEnabled`), `pnpm-workspace.yaml` (catálogo y `allowBuilds`) y `.gitignore` si hace falta.
- **T6**: `apps/landing/src/components/site/**` (Astro) y `apps/landing/src/content/**` (textos de la landing por pagador). Modifica `[payer].astro` para montar las secciones.
- **T7**: `apps/landing/src/lib/intake/**`, que incluye `invoice-reader.worker.ts`, `worker-client.ts`, `zip-extract.ts`, `intake-state.ts` y `problem-text.ts`.
- **T8**: `apps/landing/src/lib/store/**`, `apps/landing/src/islands/calculator/**` y el montaje de la isla en `[payer].astro`.
- **T9**: `apps/landing/src/islands/request-form/{RequestForm.tsx, steps/InvoicesStep.tsx, invoices/**}` y el montaje de la isla en `[payer].astro`.
- **T10**: `apps/landing/src/islands/request-form/{steps/AdvanceStep.tsx, steps/ContactStep.tsx, closing/**, form-model.ts, step-status.ts}`.
- **T11**: `apps/landing/src/lib/submit/**` (cliente XHR, huella, tabla de respuestas y Turnstile) y `apps/landing/src/islands/request-form/{submission/**, confirmation/**}`.
- **T12**: `apps/landing/src/lib/draft/**` y el enganche en `RequestForm.tsx`.
- **T13**: `apps/landing/src/scripts/{sticky-bar.ts, form-steps-bar.ts, keyboard.ts}` y los estilos de móvil de las secciones y de las islas.
- **T14**:
  - Crea `apps/landing/{wrangler.jsonc, public/_headers (o su generador), src/pages/robots.txt.ts, src/pages/og/[payer].png.ts, src/scripts/chunk-reload.ts}`, el `_redirects` generado y `.github/workflows/landing-deploy.yml`.
  - Modifica `astro.config.ts` (`security.csp`, sitemap) y `BaseLayout.astro` (metadatos, OG y beacon opcional).
- **T15**:
  - Crea `apps/landing/{playwright.config.ts, e2e/**, e2e/.env.e2e.example}`.
  - Modifica `docker/postgres/init/01-create-databases.sh` (agrega `anticipate_e2e`) y el script `e2e:prepare` en `apps/api/package.json` con su guarda de sufijo `_e2e`.
  - Modifica `.github/workflows/ci.yml` (job `e2e`; en `verify`, el build de la landing con fixtures y `wrangler deploy --dry-run`), `turbo.json` (`test:e2e`), `README.md`, `docs/STACK.md` v0.9 y la bitácora `REPO/.superpowers/sdd/2026-09-24-base-de-datos-y-api-minima/progress.md` (ruta absoluta).

## 3. Fase A · shared, API y correos

### 3.1 Tarea 1 · `@anticipate/shared/intake`

Subpath nuevo `./intake`. Se **mueven**, no se copian, desde `apps/api/src/modules/advance-requests/domain/services/`, junto con sus tests adaptados:

- **`intake/pdf-pairing.ts`**:
  - `isPdf(bytes: Uint8Array): boolean`: mira solo los primeros 1024 bytes y los convierte con `String.fromCharCode` byte a byte, sin `Buffer`. Misma expresión `PDF_HEADER`.
  - `baseName(name: string): string`.
  - `pairPdfs<T extends IntakeFile>(xmls, pdfs, maxPdfBytes): PdfPairing<T>`, con el mismo comportamiento.
- **`intake/file-names.ts`**: `displayFileName` y `screenFileNames<T extends IntakeFile>`.
- **`intake/xml-reading.ts`**: `oversizedXmlProblem`, `toXmlFileReading` y `unreadableXmlProblem`, más los tipos `ReadInvoice<T>` y `XmlFileReading<T>`.
- **`intake/validation-context.ts`**: `buildValidationContext(payer: PayerConditions, supplierRuc: string | undefined, today: IsoDate): ValidationContext`. Con `supplierRuc === undefined`, el contexto no lleva la propiedad (hay `exactOptionalPropertyTypes`).
- **Tipos en `intake/types.ts`**:
  - `IntakeFile = { readonly originalname: string; readonly buffer: Uint8Array; readonly size: number }`.
  - `PayerConditions = Pick<PublicPayer, 'slug' | 'ruc' | 'shortName' | 'advancePercent' | 'minTermDays' | 'maxInvoices' | 'allowedCurrencies'>`. Si la API tiene su propio `PayerConditions`, pasa a usar este.
- **Nuevo, `intake/grouping.ts`**: `groupInvoicesForSubmission(invoices: readonly ParsedInvoice[], advancePercent: number): InvoiceGroup[]`.
  - Tipo: `InvoiceGroup = { key: string; currency: Currency; issuerRuc: string; issuerName: string; invoices: ParsedInvoice[]; netPendingTotal: Amount; maxAdvance: Amount }`.
  - `key` es `${currency}|${issuerRuc}`.
  - `netPendingTotal` suma el neto pendiente de cada factura con `shared/money`: el mismo dato que usa `validateInvoices`.
  - `maxAdvance = percentOf(netPendingTotal, advancePercent)`.
  - Orden: `netPendingTotal` de mayor a menor, luego la cantidad de facturas de mayor a menor, luego `key`. Lista vacía si no hay facturas.
- **La API**:
  - `UploadedFile` pasa a ser `IntakeFile & { readonly buffer: Buffer }`. Los llamados no cambian, porque `Buffer` es un `Uint8Array`.
  - `InvoiceIntakeService` y el resto importan de `@anticipate/shared/intake`.
  - Todos los tests de la API siguen verdes sin cambiar su comportamiento: unitarios, de integración y `architecture.test.ts`.
- **Tests**:
  - Los que se mueven.
  - fast-check para `baseName` (idempotente, sin separadores de ruta).
  - fast-check para `groupInvoicesForSubmission`: la suma de los grupos es la suma total; ninguna factura queda en dos grupos; cada grupo tiene una moneda y un emisor.
  - `isPdf` con la marca UTF-8, espacios delante, la cabecera partida en el byte 1024 y HTML que menciona `%PDF-`.

### 3.2 Tarea 2 · Normalizadores y ayudas para personas

Base: `SCRATCH/step3-lab/form-logic/paste/normalize.ts` y su test (8 tests que pasan, más propiedades con fast-check). El contrato de la API sigue estricto: la landing normaliza antes de armar el `form`.

- **`text/pasted.ts`**: `cleanPasted(text: string): string` quita `\p{Cf}` (marcas de dirección de WhatsApp U+202A–U+202E, U+200E y U+200F, y el cero ancho), pasa a NFKC y recorta.
- **`money/amount-input.ts`**: `parseAmountInput(text: string): Amount | null`.
  1. Pasa por `cleanPasted`. Luego quita `S/`, `s/`, `US$`, `$`, `PEN`, `USD` y los espacios, incluidos NBSP y U+202F.
  2. Con coma y punto a la vez, el último es el decimal.
  3. Un solo tipo de separador seguido de exactamente 3 dígitos es de miles, en todas sus apariciones (`12,450`, `1.234.567`).
  4. Un solo separador seguido de 1 o 2 dígitos al final es el decimal (`12450,5`, `12450.50`).
  5. Nunca se redondea. Más de 2 decimales, letras, negativos, cero o vacío dan `null`.
  6. Devuelve el `Amount` canónico con 2 decimales.
  Tests:
  - tabla de casos pegados reales;
  - propiedad de ida y vuelta con `Intl.NumberFormat` en `es-PE`, `en-US`, `de-DE` y `fr-FR`;
  - propiedad: toda salida no nula la acepta `amountSchema` sin cambios.
- **`money/format.ts`**: `formatMoney(amount: Amount, currency: Currency): string` da `S/ 12,450.00` y `US$ 3,200.00`, con miles con coma, decimal con punto y siempre 2 decimales. `CURRENCY_SYMBOLS: Readonly<Record<Currency, string>>`. Implementación propia sobre el texto del `Amount`, sin `Intl`, para que la salida sea idéntica en Node y en cualquier navegador. Propiedad: `parseAmountInput(formatMoney(a, c)) === a`.
- **`identity/mobile.ts`**:
  - `mobileSchema` se mueve desde `advance-request/form.ts` y `form.ts` lo importa.
  - `isValidMobile(text)`.
  - `normalizeMobileInput(text): string | null`: `cleanPasted`, quita espacios, guiones, puntos y paréntesis, y acepta el prefijo `+51`, `0051` o `51` solo si quedan 9 dígitos que empiezan con 9.
  - `formatMobile(nineDigits)` da `987 654 321`.
- **`identity/dni.ts`**: `normalizeDniInput(text)` quita espacios, puntos y guiones, y ignora solo un dígito verificador tras guion con el patrón exacto `12345678-9`. Devuelve 8 dígitos o `null`.
- **`identity/ruc.ts`**: `normalizeRucInput(text)` devuelve 11 dígitos o `null`, sin validar el módulo 11.
- **Correo**: `normalizeEmailInput(text)` en `text/pasted.ts` aplica `cleanPasted`, recorta y pasa a minúsculas. `architecture.test.ts` de shared permite que `identity` y `money` usen `text`.
- **`advance-request/source.ts`**:
  - `sanitizeUtm(params: URLSearchParams): Record<string, string> | undefined`:
    - toma solo las claves que, en minúsculas, cumplen `^utm_[a-z_]{1,36}$`, y gana la primera aparición;
    - recorta el valor y lo trunca a 200 puntos de código;
    - descarta valores vacíos o que no cumplen `isXmlText`;
    - se queda con a lo sumo 10 claves;
    - devuelve `undefined` si no queda ninguna.
  - `sanitizeReferrer(referrer: string): string | undefined`: solo `http:` y `https:`, hasta 2000 caracteres, con `isXmlText`.
  - Test: el resultado siempre pasa `advanceRequestFormSchema.shape.source`.
- **`advance-request/form.ts`**: `CONTACT_TIME_SLOT_PHRASES: Readonly<Record<ContactTimeSlot, string>> = { MORNING: 'por la mañana (9 a 13 h)', AFTERNOON: 'por la tarde (14 a 18 h)', ANY: 'en cualquier horario' }`.
- **Subpath nuevo `@anticipate/shared/company`**:
  - `ANTICIPATE_COMPANY` es un objeto congelado con estos campos:

    | Campo | Valor |
    |---|---|
    | `legalName` | `'Anticipate S.A.C.'` |
    | `ruc` | `'20606387912'` |
    | `address` | `'Av. Velasco Astete 833, Of. 102, San Borja, Lima'` |
    | `phoneDisplay` | `'+51 954 180 802'` |
    | `whatsappNumber` | `'51954180802'` |
    | `supportEmail` | `'soporte@anticipate.pe'` |
    | `privacyEmail` | `'privacidad@anticipate.pe'` |

  - `whatsappUrl(text?: string): string` da `https://wa.me/51954180802`, con `?text=` codificado con `encodeURIComponent` si hay texto.
  - `SUPPLIER_WHATSAPP_GREETING = 'Hola, soy proveedor de SEA y tengo una consulta sobre el adelanto de mis facturas'`. El nombre del pagador es un parámetro: `supplierGreeting(payerShortName)`.
  - Un comentario marca la dirección como pendiente de confirmación de Matías.

### 3.3 Tarea 3 · API para la landing

- **`GET /api/v1/legal-documents`**:
  - Público: usa el throttler general, sin captcha ni cupo de envíos.
  - `Cache-Control: public, max-age=300` solo en 200.
  - `data: CurrentLegalDocument[]`, donde cada elemento es `{ type: 'TERMS' | 'PERSONAL_DATA'; version: string; url: string; publishedAt: string }`, con `publishedAt` en ISO 8601 UTC. Incluye solo las filas con `retired_at IS NULL`, ordenadas por `type` y luego por `publishedAt` descendente.
  - Esquemas `currentLegalDocumentSchema` y `currentLegalDocumentsSchema` en `@anticipate/shared/api`. `ConsentType` sale de donde ya lo defina shared; si no está, se agrega junto al esquema.
  - Módulo por capas como `payers`: puerto de lectura, caso de uso, repositorio Prisma con `select`, mapper, controlador con Swagger y módulo con `useFactory`. Se registra en `app.module.ts`.
  - Tests unitarios y de integración:
    - sin filas, responde `[]`;
    - una versión retirada no aparece;
    - dos vigentes del mismo tipo aparecen las dos, la más nueva primero;
    - la cabecera de caché;
    - el sobre se valida con `apiSuccessEnvelopeSchema(currentLegalDocumentsSchema)`.
- **Qué hace la landing con esto**: en el build envía, para cada tipo, la versión vigente más reciente (`publishedAt` mayor) y enlaza su `url`. El build falla si falta un tipo.
- **`THROTTLE_SUBMIT_LIMIT`**: el valor por defecto pasa de 5 a 20 dentro de `THROTTLE_SUBMIT_TTL_SECONDS` 3600. Cambian el esquema, `.env.example`, los tests del esquema y la documentación que cite el 5.
- **`apps/api/prisma/seed.ts`**:
  - SEA con sus datos reales:

    | Campo | Valor |
    |---|---|
    | `slug` | `'sea'` |
    | `ruc` | `'20525998577'` |
    | `legalName` | `'SERVICIOS ENERGETICOS AMBIENTALES S.R.L. - SEA S.R.L.'` |
    | `shortName` | `'SEA'` |
    | `advancePercent` | 85 |
    | `minTermDays` | 15 |
    | `maxInvoices` | 10 |
    | `allowedCurrencies` | `['PEN', 'USD']` |
    | `accentColor` | el actual |
    | `logoUrl` | `null` |
    | `texts` | los actuales |

  - El `upsert` pasa a actualizar (`update` con los mismos datos), para corregir bases existentes, y lleva un comentario que lo explica.
  - Las versiones legales de desarrollo quedan igual (`2026-09`).
  - Los fixtures de tests conservan el RUC ficticio 20131312955 y no se tocan.
  - La migración de datos de producción de SEA queda para la salida a producción, cuando Matías confirme el plazo mínimo, el máximo de facturas, el color y el logo (pendiente en STACK §14).
  - La tarea corre `pnpm db:seed` sobre la base de desarrollo, y lo verifica con `curl http://127.0.0.1:4001/api/v1/payers` si la API está levantada.
- **Humo del job `image` en `ci.yml`**: agrega `curl /api/v1/intake-limits` y `curl /api/v1/legal-documents` con `jq -e '.success == true'` y la cabecera de caché.

### 3.4 Tarea 4 · Correo de confirmación completo

- **`packages/emails`, confirmación al proveedor**: agrega los textos del tablero 7 de `Estados.dc.html`:
  - "Revisamos tu solicitud en menos de 24 horas hábiles y te enviamos la propuesta por correo y celular."
  - "Te llamaremos {CONTACT_TIME_SLOT_PHRASES[slot]} desde el {phoneDisplay}. Guárdalo para reconocernos."
  - "Para avanzar más rápido, ten a mano: DNI del representante legal · Vigencia de poder del representante legal".
  - El botón de WhatsApp con `whatsappUrl('Hola, tengo una consulta sobre mi solicitud ' + publicCode)`.
  - `soporte@anticipate.pe`.
  - El pie ya no dice solo "no respondas": dice "Para cualquier consulta, escríbenos a soporte@anticipate.pe o por WhatsApp al +51 954 180 802."
- **Montos**: en los dos correos (confirmación y aviso al equipo) salen con `formatMoney`.
- **La API**: arma esos datos con lo que ya guarda (`contactTimeSlot`, `publicCode`, `requestedAmount` y `currency`). Se actualizan los tests y las instantáneas de `packages/emails`, y los del handler y el mapper de datos del correo.

## 4. Fase B · `apps/landing`

### 4.1 Configuración (Tarea 5)

- **`package.json`**:
  - `name` es `@anticipate/landing`, con `private` y `type: module`.
  - Scripts:

    | Script | Comando |
    |---|---|
    | `dev` | `astro dev --port 4321` |
    | `build` | `astro build` |
    | `typecheck` | `astro check` |
    | `test` | `vitest run --coverage` |
    | `test:e2e` | `playwright test` (Tarea 15) |
    | `preview` | `wrangler dev --port 8788 --ip 127.0.0.1` |

  - Dependencias de `@anticipate/shared` con `workspace:*`. Nunca importa `@anticipate/shared/testing` desde `src/`: solo desde tests y `e2e/`.
- **shared se consume desde `dist`**, como la API (D30). No se agrega la condición `@anticipate/source` a shared: rompe el build de la API, como mostró el lab. En turbo, `@anticipate/landing#dev` lleva `dependsOn: ["^build"]`.
- **`tsconfig.json`**:
  - Extiende `@anticipate/config/tsconfig.base.json`.
  - Agrega `lib: ["ES2022", "DOM", "DOM.Iterable", "WebWorker"]` si hace falta para el worker (o un tsconfig propio del worker), `jsx: "react-jsx"`, `jsxImportSource: "react"` y `allowImportingTsExtensions`.
  - `include` con `.astro/types.d.ts` y `src`.
- **`astro.config.ts`**:
  - `output: 'static'`, `site: PUBLIC_SITE_URL`, `trailingSlash: 'never'`, `build.format: 'file'`.
  - Integraciones: `react()` y `sitemap({ filter })` (Tarea 14).
  - Fuente: `fonts: [{ provider: fontProviders.local(), name: 'Archivo', cssVariable: '--font-archivo', options: { variants: [{ weight: '100 900', style: 'normal', src: ['@fontsource-variable/archivo/files/archivo-latin-wght-normal.woff2'] }] } }]`, y `<Font cssVariable="--font-archivo" preload />` en el layout. Si la forma exacta cambia en Astro 7.3, la verifica el escritor.
  - `markdown.syntaxHighlight: false`.
  - `security.csp` (Tarea 14).
  - `env.schema` con `validateSecrets: true`.
- **Entorno con astro:env**:

  | Variable | Contexto | Tipo | Uso |
  |---|---|---|---|
  | `LANDING_API_URL` | server, secret | url, opcional | API que lee el build |
  | `LANDING_DATA` | server, public | enum `api` \| `fixtures`, por defecto `api` | origen de los datos del build |
  | `LANDING_INDEXABLE` | server, public | boolean, por defecto `false` | si los buscadores pueden indexar |
  | `LANDING_ROOT_REDIRECT` | server, public | string, opcional | por ejemplo `/sea` |
  | `PUBLIC_SITE_URL` | client, public | url | host canónico |
  | `PUBLIC_API_BASE_URL` | client, public | string, puede ir vacío | origen al que envía el navegador; vacío activa el modo demostración |
  | `PUBLIC_TURNSTILE_SITE_KEY` | client, public | string | clave del widget |
  | `PUBLIC_CF_BEACON_TOKEN` | client, public | string, opcional | Web Analytics |

  - Con `LANDING_DATA=api`, `LANDING_API_URL` es obligatorio.
  - `LANDING_DATA=fixtures` nunca se publica: `landing-deploy.yml` falla si lo ve.
  - `apps/landing/.env.example` apunta a la API local (`http://127.0.0.1:4001`), y un test exige que declare exactamente las claves del esquema.
- **Datos del build**, en `src/lib/build-data/`:
  - Módulos puros `fetchPublicPayers(baseUrl, fetchImpl)`, `fetchIntakeLimits(...)` y `fetchLegalDocuments(...)`.
  - Cada uno hace hasta 3 intentos solo ante red, 5xx o 429, con timeout de 10 s y espera exponencial.
  - Piden con `cache: 'no-store'` y `?build=<id>` (`GITHUB_RUN_ID` o `Date.now()`).
  - Validan con `apiSuccessEnvelopeSchema(...)` de shared.
  - El build falla con un mensaje en español si la API no responde, si la lista de pagadores viene vacía, si falla el contrato o si falta un tipo legal.
  - Un módulo delgado, `build-data.server.ts`, lee astro:env y guarda la promesa, así la API se consulta una sola vez por build.
  - Con `LANDING_DATA=fixtures` lee `src/lib/build-data/fixtures.ts`: SEA con sus datos reales, los topes por defecto (20 archivos, 1 MiB, 10 MiB, 95 000 000) y las versiones `2026-09`. Todo validado con los mismos esquemas.
- **Turbo**:
  - `@anticipate/landing#build` con `dependsOn: ["^build"]`, `cache: false`, `env: ["LANDING_*", "PUBLIC_*"]` y `outputs: ["dist/**"]`.
  - `@anticipate/landing#typecheck` y `#test` con `dependsOn: ["^build"]`.
  - `@anticipate/landing#dev` con `dependsOn: ["^build"]`, `cache: false` y `persistent: true`.
  - `globalPassThroughEnv` con `ASTRO_TELEMETRY_DISABLED` y `WRANGLER_SEND_METRICS`.
  - `pnpm verify` en local construye la landing con `LANDING_DATA=fixtures`: el script `verify` de la raíz lo exporta solo para esa corrida.
- **Biome**: `"html": { "experimentalFullSupportEnabled": true }` en `biome.json`.
- **Vitest**:
  - `apps/landing/vitest.config.ts` con `test.name: 'landing'`, entorno `jsdom` y `setupFiles` con `@testing-library/jest-dom/vitest`.
  - Los módulos que hablan HTTP se prueban con `// @vitest-environment node` contra un servidor `node:http` local: en jsdom, el FormData sale como `text/plain`.
  - Cobertura v8 sobre `src/lib/**` con los umbrales de shared.
- **Estilos**:
  - `src/styles/tokens.css` con los tokens del diseño en `:root`, copiados de `Main.dc.html`: `--ink`, `--muted`, `--line`, `--field`, `--surface`, `--teal`, `--teal-600`, `--teal-700`, `--teal-800`, `--teal-900`, `--teal-100`, `--teal-200`, `--err`, `--err-bg`, `--warn`, `--warn-bg`, `--off` y `--off-bg`. También `--payer-accent`, que el layout pisa con el `accentColor` del pagador.
  - Esquinas rectas.
  - Estilos con ámbito de Astro para las secciones y CSS Modules para las islas.
  - Sin Tailwind, shadcn ni `packages/ui` (D60).
- **Páginas**:
  - `src/pages/[payer].astro`, con `getStaticPaths` desde los datos del build.
  - `src/pages/index.astro`: una página mínima de Anticipate con `noindex` y un enlace a cada pagador. Si `LANDING_ROOT_REDIRECT` está definido, `_redirects` además manda `/` a esa ruta con 302 (Tarea 14).
  - `src/pages/404.astro`, con `noindex` y enlaces a los pagadores.

### 4.2 Secciones estáticas (Tarea 6)

- Componentes Astro sin JavaScript en `src/components/site/`:

  | Componente | Contenido |
  |---|---|
  | `SiteHeader` | escritorio: logo, Cómo funciona, Requisitos, Preguntas, WhatsApp, "Solicitar adelanto" hacia `#paso-facturas`; móvil: `<details>` con el menú del marco 1 de `MobileExtras`, que suma "¿Dónde está mi XML?" |
  | `Hero` | antetítulo "Programa de Anticipate Factoring para proveedores de" y logo del pagador en escritorio; "Para proveedores de" y logo en una línea en móvil; titular en 2 líneas (50 px en escritorio); puntos del hero solo en escritorio; espacio para la isla de la calculadora |
  | `Benefits` | escritorio: 85 %, 24 h, Abono, Tú decides; móvil: Infocorp en lugar de Abono |
  | `HowItWorks` | cómo funciona |
  | `Requirements` | etiquetas "Lo vemos en tu XML" y "Lo revisamos nosotros", "Después te pediremos" |
  | `XmlGuide` | 3 filas en escritorio y 4 en móvil, con el enlace "Pídeselos por WhatsApp" (`https://wa.me/?text=` más la URL canónica de la página) y el aviso "Ojo" |
  | `Faq` | `<details>`/`<summary>` con las 10 preguntas |
  | `ClosingBand` | la franja final |
  | `SiteFooter` | el pie |

- Los textos salen de `src/content/landing-copy.ts`:
  - `landingCopy(payer: PublicPayer)` devuelve los textos del diseño con el `shortName`, el `advancePercent`, el `minTermDays`, el `maxInvoices` y las monedas del pagador interpolados. Nunca "SEA", "85" ni "10" fijos.
  - Los `texts` del pagador pisan claves conocidas y tipadas (`title`, `subtitle`).
  - Datos de contacto desde `ANTICIPATE_COMPANY`.
- **Adaptable**: una sola maqueta que se ve como `Main.dc.html` desde 1024 px y como `Mobile.dc.html` hasta 767 px, con un paso intermedio razonable entre ambos. Unidades y medidas copiadas del diseño. Blancos a 16–20 px en móvil, sin desplazamiento horizontal a 360 px.
- **Accesibilidad**:
  - enlace "Saltar al formulario";
  - encabezados en orden;
  - objetivos de al menos 44×44 px;
  - `:focus-visible` del diseño;
  - contraste AA, con los tokens `--field` y `--muted` ya ajustados;
  - `lang="es"`.
- **Tests**: Container API de Astro (`experimental_AstroContainer`) para renderizar cada sección con un pagador de fixture y comprobar textos interpolados, enlaces y `details`. Si el Container API no corre en jsdom, se usa entorno node.

### 4.3 Lectura de facturas en el navegador (Tarea 7)

- **Worker propio** `src/lib/intake/invoice-reader.worker.ts`, creado con `new Worker(new URL('./invoice-reader.worker.ts', import.meta.url), { type: 'module' })`:
  - Vite lo empaqueta con su formato por defecto, y nunca con esbuild directo.
  - Se crea al primer contacto con una zona de subida o en `requestIdleCallback`.
- **Protocolo** (`worker-client.ts`):
  - Mensajes con `id` y una cola FIFO. Plazo de 10 s por archivo: si se vence, `terminate()`, se recrea el worker y el archivo queda como "No se pudo leer".
  - Sin Worker disponible, lee en el hilo principal solo los archivos de hasta 256 KB y marca el resto como "No se pudo leer".
- **El worker recibe un `File` y devuelve lecturas**. Para cada entrada con nombre, bytes y tamaño real:
  - Un XML devuelve `ParseResult` de `parseUblInvoice(decodeXml(bytes), { maxLength: maxXmlBytes })` más sus bytes.
  - Un PDF devuelve sus bytes.
  - Los bytes van como `ArrayBuffer` transferible. Se lee una vez y se envían esos mismos bytes: el `FormData` usa `new Blob([bytes])` y el nombre.
- **.zip** (`zip-extract.ts`, base `SCRATCH/step3-lab/form-logic/pipeline/zip-extract.ts`): fflate `Unzip` y `UnzipInflate` en streaming, dentro del mismo worker.
  - Topes del archivo:
    - el zip pesa hasta `maxBodyBytes`;
    - el registro EOCD se lee antes, se aceptan hasta 200 entradas y no se admite ZIP64;
    - trozos de 64 KB, para evitar el desborde de pila de fflate hacia las 2500 entradas;
    - solo los métodos 0 y 8.
  - Topes por entrada:
    - sobre bytes reales: `maxXmlBytes` o `maxPdfBytes`; al pasarlo, se corta;
    - el tamaño real debe coincidir con el declarado cuando se conoce;
    - el total conservado llega hasta `maxBodyBytes`.
  - Entradas que se descartan en silencio:
    - carpetas;
    - `__MACOSX/`;
    - nombres que empiezan con punto;
    - zips anidados;
    - `R-*.xml` (la CDR, por nombre);
    - después de leer, un XML cuya raíz es `ApplicationResponse` (`params.kind`).
  - Nombres: el nombre base sin carpeta, con `isFileName`. A cada PDF se le aplica `isPdf`.
  - Mensajes claros para zip con contraseña o dañado, zip sin facturas y zip demasiado grande.
- **Estado de admisión** (`intake-state.ts`, puro y en el hilo principal): `IntakeState` inmutable, con funciones `addReadings`, `removeFile`, `undoRemove`, `assignPdf`, `chooseGroup` y `replaceFile`.
  1. `screenFileNames` y los topes por archivo (`oversizedXmlProblem`; `FILE_TOO_LARGE` si el PDF pasa el tope).
  2. Reglas por factura con `INVOICE_RULES` sobre `buildValidationContext(payer, undefined, todayIn(LIMA_TIME_ZONE, new Date()))`, y duplicados por `invoiceKey`.
  3. PDF con `pairPdfs` por nombre base. Un PDF suelto queda como "¿De qué factura es?" y no se envía hasta asignarlo; al asignarlo, viaja con el nombre `<base del XML>.pdf`.
  4. Estado de cada factura:
     - `ready`;
     - `not-eligible`: con sus `Problem`, fuera del total, "No se enviará";
     - `unreadable`: con "Reemplazar archivo";
     - `duplicate`.
     Estado de cada archivo: `loose-pdf` u `oversized`.
  5. Si el emisor del grupo tiene un RUC que no pasa `isValidRuc`, o una razón social fuera de 3 a 200 caracteres, sus facturas pasan a `not-eligible` con el motivo. El `form` sale de ahí y la API respondería con un 400 que el proveedor no puede corregir.
  6. Grupos con `groupInvoicesForSubmission` sobre las `ready`. Con más de un grupo, el proveedor elige cuál envía; por defecto, el primero (el de mayor neto). Los demás quedan "para otra solicitud".
  7. Tope `maxInvoices`: entran las primeras N en orden de llegada, y las demás aparecen en "no entraron".
  8. Totales del grupo elegido: facturas, neto pendiente y adelanto máximo.
  9. Topes del envío con `submissionBodyBytesUpperBound` y `maxFiles`. Si pasan, se pide quitar PDF.
  10. Conjunto final con `validateInvoices` sobre las facturas a enviar.
- **Textos por problema** (`problem-text.ts`):
  - `Record<ProblemCode, (problem, invoice?) => string>`, exhaustivo: un código nuevo rompe el typecheck.
  - Usa el texto del diseño: "Vence el 05/10/2026, en 9 días. Para adelantarla deben faltar al menos 15 días."; "cuota 1", no "Cuota001"; fechas con `formatIsoDate`.
  - El `message` de shared queda como respaldo.
- **Tests**:
  - Lector real con `buildInvoiceXml` de `@anticipate/shared/testing` (al contado, vencida, en dólares, emitida a otro, boleta y CDR), con `vi.setSystemTime`.
  - Zips generados en el test con fflate (`zipSync`): normal, bomba, tamaño declarado falso, 250 entradas, CDR, `__MACOSX`, anidado y `../evil.xml`.
  - Estado de admisión con fast-check: ninguna factura en dos grupos, y ningún total que sume una factura que no es `ready`.

### 4.4 Calculadora (Tarea 8)

- **Isla `Calculator.tsx`** con `client:load`, porque está en el primer pantallazo. Comportamiento del tablero `Main.dc.html`:
  - Montos discretos: 1 000 a 10 000 de 500 en 500, 11 000 a 100 000 de 1 000 en 1 000 y 105 000 a 500 000 de 5 000 en 5 000 (189 valores). Marcas en 0, 9,6 %, 57,4 % y 100 %.
  - Moneda desde `allowedCurrencies`: si hay una sola, sin selector.
  - Etiqueta "¿Cuánto te va a pagar {shortName}?" con la ayuda debajo.
  - Campo con `parseAmountInput` al pegar y al salir; selecciona todo al enfocarse; `inputMode="decimal"`.
  - `<output>` con `formatMoney(percentOf(monto, advancePercent))`.
  - Sin "Referencial". La nota "Monto referencial…" va al pie.
- **Modo manual**: botón de contorno a todo el ancho, "Subir mis XML y ver el monto exacto", que abre el selector de archivos (acepta `.xml`, `.pdf` y `.zip`).
- **Modo XML**:
  - facturas leídas con sus marcas;
  - aviso compacto si alguna no califica (tablero 3 de Estados);
  - botón verde "Continuar con estas {n} facturas" hacia `#paso-facturas`;
  - "Calcular con otro monto".
- **En móvil**: "¿Tus XML están en la computadora? Envíate este enlace". Usa `navigator.share` si existe y, si no, `mailto:` con la URL canónica.
- **Almacén compartido** (`src/lib/store/intake-store.ts`): módulo con `subscribe`, `getSnapshot` y acciones, leído con `useSyncExternalStore`, sin dependencias. La calculadora y el formulario comparten el mismo `IntakeState`.
- **Tests**: Testing Library con `user.paste('12,450.00')`, el deslizador, la moneda y el paso a modo XML con archivos reales.

### 4.5 Formulario (Tareas 9 y 10)

- **Isla `RequestForm.tsx`** con `client:idle` (no `client:visible`: ver D68). Hasta hidratarse, el HTML del formulario se ve deshabilitado.
- **Estado del formulario sin librerías**: un `useReducer` con el modelo en `form-model.ts`.
  - Al salir del campo y al enviar, se valida con `advanceRequestFormSchema` de shared sobre el modelo ya normalizado.
  - Los errores se asignan por ruta del issue de Zod al campo.
  - Sin `react-hook-form`: su versión vigente todavía no cumple `minimumReleaseAge`, y un reducer con el esquema de shared alcanza.
- **Paso 01** (Tarea 9, tablero `Main.dc.html` y tableros 1, 2, 3 y 6 de Estados):
  - "Trajimos tus {n} facturas de la calculadora. Puedes agregar más, hasta {maxInvoices}".
  - Lista primero.
  - Botón "+ Agregar otra factura · XML, PDF o .zip", con arrastrar y soltar sobre la lista.
  - Área grande solo con la lista vacía.
  - Cada factura muestra "XML ✓ · PDF opcional" o "XML ✓ · PDF ✓", "Agregar PDF (opcional)" y "Quitar". Al quitar, aparece el aviso "Quitaste F001-… · Deshacer" durante 8 s, con `role="status"`.
  - Tarjetas atenuadas para "No se puede adelantar".
  - Estados "No se pudo leer" y "¿De qué factura es?".
  - Grupos con la elección "{n} en soles · {total}" o "{n} en dólares · {total}".
  - Aviso "no entraron" y aviso de peso.
  - Línea del emisor leído del XML.
  - Nota "Neto pendiente: el total de la factura menos detracción y retención; lo que {shortName} te va a pagar."
  - Cavali con Sí, No y No sé.
- **Paso 02** (Tarea 10): monto prellenado con el máximo del grupo, `parseAmountInput` y `validateRequestedAmount`; "Máximo {max}. Puedes pedir menos."; motivo con select opcional y sus 7 opciones.
- **Paso 03** (Tarea 10):
  - Ficha de confianza al inicio: "Tus datos los recibe y evalúa Anticipate S.A.C.", RUC, dirección, WhatsApp y soporte.
  - Nombre, DNI, celular y correo, sin `maxlength`, con los normalizadores de shared al pegar y al salir, y los `autocomplete` e `inputmode` correctos.
  - Representante legal Sí/No; con No, se piden cargo y aviso.
  - Horario con `CONTACT_TIME_SLOT_LABELS`, y la nota del +51 954 180 802.
- **Cierre** (Tarea 10):
  - "Vas a enviar" con el monto, las facturas, el celular formateado, el horario (`CONTACT_TIME_SLOT_PHRASES`), el correo y los enlaces "Cambiar".
  - Consentimientos con enlaces a las `url` legales del build.
  - Aviso por capas "Ver cómo cuidamos tus datos".
  - "Enviar no te obliga a nada…" encima del botón.
  - "Protegido por Cloudflare Turnstile".
- **Pasos por avance** (`step-status.ts`, puro): cada paso está `done`, `current` o `todo`, con su texto: "✓ {n} facturas · {total}", "Falta 1 dato", "Faltan {n} datos" o "Pendiente".
  - El paso 02 está completo con un monto válido; el motivo no cuenta.
  - El paso 03 cuenta el nombre, el DNI, el celular, el correo, el representante (y el cargo si hace falta) y el horario.
  - En escritorio, columna izquierda fija (`position: sticky`).
- **Resumen de errores al enviar**: con `role="alert"`, "Te falta completar {n} datos:" con enlaces, y el foco va al resumen.

### 4.6 Envío y confirmación (Tarea 11)

- **Cliente** (`src/lib/submit/xhr-client.ts`):
  - `XMLHttpRequest` con `FormData`. Nunca `fetch` con stream: la API responde 411 sin `Content-Length`.
  - Timeout de 120 s. `upload.onprogress` alimenta "Subiendo {n} archivos ({MB} MB)".
  - Lee las cabeceras `idempotent-replayed`, `Retry-After` y `x-correlation-id`.
  - El cuerpo se valida con `apiSuccessEnvelopeSchema(advanceRequestCreatedSchema)` o con `apiErrorEnvelopeSchema`.
- **Partes del envío**: `form` (JSON), un `xml` por cada factura del grupo elegido y un `pdf` por cada PDF emparejado (nombre `<base>.pdf`).
- **El `form`**:
  - `company.ruc` y `company.legalName` salen del emisor del grupo.
  - `payerSlug` es el slug del pagador.
  - `source` es `{ utm: sanitizeUtm(...), referrer: sanitizeReferrer(...) }`, leídos una sola vez en la primera visita y guardados en el borrador.
  - `consents` lleva las versiones del build.
- **Idempotencia**:
  - Al primer "Enviar" se calcula una huella: SHA-256 (`crypto.subtle`) del JSON canónico del `form` más el nombre y el SHA-256 de cada archivo.
  - Se genera `crypto.randomUUID()` y se guardan la clave y la huella en el borrador.
  - Con la misma huella, incluso después de recargar, se reusa la clave. Si la huella cambia, la clave es nueva.
  - Después de un 201, "Enviar otra solicitud" genera una clave nueva.
- **Turnstile** (`src/lib/submit/turnstile.ts`, envoltorio propio de unas 60 líneas):
  - Carga `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit` una sola vez.
  - `render` con `appearance: 'interaction-only'`, `execution: 'execute'`, `callback`, `error-callback`, `expired-callback` y `before-interactive-callback`.
  - Al enviar, llama a `execute()` y espera el token con un tope de 15 s. Sin callback en ese tiempo muestra "No pudimos cargar la verificación", con reintento y WhatsApp.
  - `reset()` después de cada respuesta: cada reintento pide un token nuevo con la misma clave de idempotencia.
- **Tabla de respuestas**: `Record<ApiErrorCode, ResponseAction>`, más las filas para 201, "sin respuesta" y "cuerpo ilegible". Un código nuevo rompe el typecheck.
  - **201**, también con `Idempotent-Replayed`: confirmación y borrado del borrador.
  - **Sin respuesta, timeout, 502, 504, 524 o cuerpo ilegible**: "Se cortó la conexión" con "Reintentar envío" y la misma clave. No se puede editar hasta tener una respuesta definitiva.
  - **503 con `Retry-After`**: reintento automático al terminar la espera, a lo sumo 2 veces, con la cuenta regresiva de "Estamos con mucha demanda".
  - **503 sin `Retry-After` o 500**: reintento manual y canales de contacto.
  - **429**: sin reintento automático. Muestra los minutos de `Retry-After`, WhatsApp y soporte.
  - **403 `CAPTCHA_FAILED`**: `reset()` y nuevo intento con la misma clave. Nunca "recarga la página".
  - **400 `VALIDATION_ERROR`**: cada `violations[].field` va a su campo, con el resumen arriba.
  - **400 `TOO_MANY_FILES` o 413**: pide quitar PDF.
  - **400 `MALFORMED_JSON`, `MALFORMED_MULTIPART`, `UNEXPECTED_FILE_FIELD`, `IDEMPOTENCY_KEY_INVALID`, `BAD_REQUEST` y 411 `LENGTH_REQUIRED`**: error general con el `correlationId` y los canales de contacto.
  - **422 `BUSINESS_RULES_VIOLATED`**: cada problema se marca según lo que trae.
    - Con `file`: la fila de ese archivo, por el nombre enviado.
    - Con `invoice`: esa factura.
    - Con `field: 'requestedAmount'`: el monto.
    - Con `payerSlug` o `consents.*`: aviso de recargar que conserva el borrador.
    - Con una clave de `ParsedInvoice`: el dato de esa factura.
    - Sin nada de eso: aviso general.
  - **422 `IDEMPOTENCY_KEY_REUSED`**: "Ya recibimos una solicitud desde esta página", remite al correo y rota la clave.
  - **404, 409 y el resto**: error general.
- **Confirmación** (tableros 7 y 8 de Estados):
  - El `h2` recibe el foco.
  - Textos del diseño con el nombre de pila, el celular formateado, `CONTACT_TIME_SLOT_PHRASES`, el correo, el monto con `formatMoney` y los números de factura.
  - WhatsApp como botón secundario: `whatsappUrl('Hola, tengo una consulta sobre mi solicitud ' + publicCode)`.
  - "Enviar otra solicitud" limpia el estado y vuelve a `#paso-facturas`.
- **Modo demostración**: con `PUBLIC_API_BASE_URL` vacío no se envía nada. La confirmación dice "Modo demostración: no enviamos tus datos" (STACK §6).
- **Tests**:
  - Entorno node con un servidor `http` local: multipart con `Content-Length`, cabeceras, progreso, timeout y lectura de `Retry-After` y `Idempotent-Replayed`.
  - La tabla completa: un test por fila.
  - La huella: estable, y distinta si cambia un byte.
  - Turnstile con `window.turnstile` simulado, incluido el tope sin callbacks.
  - La confirmación.

### 4.7 Borrador (Tarea 12)

- **Almacenamiento**:
  - idb-keyval con `createStore('anticipate-landing', 'drafts')` y un registro por pagador con la clave `draft:v1:<slug>`.
  - El registro guarda:
    - `v`, `savedAt` y `expiresAt` (72 h desde el último cambio);
    - el paso;
    - las respuestas ya normalizadas, y el texto crudo de los campos inválidos;
    - la UTM y el referrer de la primera visita;
    - los archivos como `{ name, kind, type, lastModified, bytes: ArrayBuffer }`. Los XML siempre; los PDF mientras el total no pase de 30 MB. Si no caben, al volver se avisa "Vuelve a adjuntar el PDF de F001-…".
    - `submission: { idempotencyKey, fingerprint, lastOutcome }`.
  - No guarda los consentimientos ni el token.
- **Cuándo se guarda**: 400 ms después del último cambio, enseguida al leer un archivo, y con `visibilitychange` a `hidden`.
- **Al volver**:
  - Cada XML se relee en el worker con la fecha de hoy; nunca se confía en un resultado guardado.
  - Aparece el aviso "Seguimos donde te quedaste · Empezar de nuevo".
- **Cuándo se borra**: con el 201 (también replay), con "Empezar de nuevo", al vencer, si cambia `v`, o con "No guardar en este dispositivo". Esta última opción deja en `localStorage` solo la marca `anticipate:no-draft=1`, sin datos personales.
- **Fallos**: todo acceso va en try/catch. Sin IndexedDB (navegación privada), la landing funciona igual y sin aviso.
- **Tests**: `fake-indexeddb` si hace falta (va al catálogo) o un almacén en memoria inyectado. Cubren el vencimiento, el tope de 30 MB, el borrado con 201 y la marca "no guardar".

### 4.8 Comportamiento móvil (Tarea 13)

- **Barra fija inferior** (marcos 2 y 2b de `MobileExtras`):
  - Aparece al pasar la calculadora.
  - Neutra: "Hasta {advancePercent} % · de tus facturas a {shortName} · Solicitar".
  - Si ya hay facturas en el almacén: "{n} facturas · {formatMoney(max)} · Te falta el paso 0X · {nombre} · Continuar". Enlaza al primer paso sin terminar.
  - Se oculta dentro de `#solicitud` y mientras el teclado está abierto (`visualViewport.height < 0.75 * innerHeight`).
  - Usa `IntersectionObserver` y un script sin framework (`sticky-bar.ts`), que lee el almacén si la isla ya hidrató; si no, muestra la versión neutra.
- **Dentro del formulario** (marco 3):
  - Solo quedan fijos los pasos; la cabecera del sitio se oculta.
  - Resaltado: el paso visible. ✓ solo cuando el paso está completo.
  - `scroll-margin-top` en `#paso-*` igual a la altura de la barra de pasos más 16 px (en escritorio, la de la cabecera más 16 px).
- **Tests**: unitarios del cálculo de visibilidad con `visualViewport` e `IntersectionObserver` simulados. El comportamiento real se prueba en E2E móvil (Pixel 7).

### 4.9 SEO, cabeceras y despliegue (Tarea 14)

- **Metadatos por pagador**:
  - `title` "Adelanta tus facturas a {shortName} · Anticipate Factoring" y `description`.
  - `canonical` con `PUBLIC_SITE_URL`.
  - Open Graph y Twitter con la imagen `og/{slug}.png`: 1200×630, generada en el build con satori y resvg, en Archivo. satori no lee woff2: el escritor verifica un archivo woff o ttf de `@fontsource-variable/archivo` o de `@fontsource/archivo` y lo fija en el catálogo.
- **Sitemap y robots**:
  - `@astrojs/sitemap` con un `filter` que deja fuera `/404` y la raíz si es solo un índice.
  - `robots.txt` como endpoint: `Allow` solo con `LANDING_INDEXABLE=true`; si no, `Disallow: /`. Siempre con la línea `Sitemap`.
  - `X-Robots-Tag: noindex` fuera de producción, en `_headers` generado por entorno.
- **CSP con `security.csp` de Astro**:
  - `directives`: `default-src 'self'`, `img-src 'self' data:`, `connect-src 'self' <origen de PUBLIC_API_BASE_URL> https://cloudflareinsights.com`, `frame-src https://challenges.cloudflare.com`, `font-src 'self'`, `form-action 'self'`, `base-uri 'self'` y `object-src 'none'`.
  - `scriptDirective.resources`: `'self'`, `https://challenges.cloudflare.com` y `https://static.cloudflareinsights.com`.
  - `styleDirective.resources`: `{ resource: "'self'", kind: 'element' }` y `{ resource: "'unsafe-inline'", kind: 'attribute' }`. Sin esta regla, los `style` de las islas se bloquean, como se verificó.
  - Nunca `'unsafe-inline'` en `script-src`.
- **`public/_headers`** (o generado por entorno):
  - `/*` con:
    - `Content-Security-Policy: frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; upgrade-insecure-requests`;
    - `Strict-Transport-Security: max-age=31536000; includeSubDomains`;
    - `X-Content-Type-Options: nosniff`;
    - `Referrer-Policy: strict-origin-when-cross-origin`;
    - `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()`;
    - `Cross-Origin-Opener-Policy: same-origin`;
    - `X-Frame-Options: DENY`.
  - `/_astro/*` con `Cache-Control: public, max-age=31536000, immutable`.
- **`_redirects`**: generado en el build desde `LANDING_ROOT_REDIRECT` (`/ /sea 302`). Solo 302 mientras la raíz sea una decisión pendiente.
- **Destino**: Workers static assets, sin adaptador. `wrangler.jsonc` con `assets.directory: './dist'`, `not_found_handling: '404-page'` y `html_handling: 'drop-trailing-slash'`, y los nombres `anticipate-landing-staging` y `anticipate-landing`.
- **Protección ante chunks viejos** (`chunk-reload.ts`): un listener de `vite:preloadError` recarga la página una sola vez por sesión (marca en `sessionStorage`). El borrador conserva lo escrito.
- **Web Analytics**: con `PUBLIC_CF_BEACON_TOKEN` se carga el beacon manual; vacío, no se carga. Sin cookies. El embudo con Worker `/e` y Analytics Engine queda como pendiente para Matías: no se construye.
- **`.github/workflows/landing-deploy.yml`**:
  - Disparadores:
    - `pull_request`: `wrangler versions upload --preview-alias pr-<n>`, con modo demostración (`PUBLIC_API_BASE_URL` vacío), la clave de prueba y noindex;
    - `push` a `main`: staging;
    - tags `v*`: producción;
    - `workflow_dispatch` con `environment` y `reason`;
    - `schedule` nocturno.
  - `concurrency: landing-deploy-<env>` con `cancel-in-progress: false`.
  - GitHub Environments con `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` y las variables `LANDING_*` y `PUBLIC_*`.
  - Falla si `LANDING_DATA=fixtures`.
  - Humo con `curl` después de desplegar: `/sea` responde 200 y trae la CSP; `/` responde 302 si hay redirección; una ruta inexistente responde 404.
  - Como no hay remoto, el flujo queda escrito y validado con `actionlint` si está disponible (o con revisión), sin ejecutarse.
- **Reconstrucción cuando cambia un pagador**: por ahora `workflow_dispatch` manual, descrito en el runbook del README. En el paso 4, un evento del outbox (`PAYER_CHANGED`) queda como pendiente. No se crea ninguna Cache Rule para `/api/*`.

### 4.10 E2E, CI y documentación (Tarea 15)

- **Playwright** (`apps/landing/playwright.config.ts`):
  - Proyectos `chromium` (1440×900) y `mobile` (Pixel 7). `retries: 1` en CI y `trace: 'retain-on-failure'`.
  - `webServer`, en orden:
    1. `pnpm --filter @anticipate/api e2e:prepare && node --env-file=<ruta>/.env.e2e ../api/dist/main.js`, con `cwd` en una carpeta sin `.env` y url `http://127.0.0.1:4010/health/readiness`.
    2. `astro build` contra esa API y después `wrangler dev --port 8788 --ip 127.0.0.1`, con url `http://127.0.0.1:8788/sea`.
- **`apps/landing/e2e/.env.e2e.example`**:
  - `NODE_ENV=test`, `PORT=4010`, `CORS_ORIGINS=http://127.0.0.1:8788`.
  - `DATABASE_URL` y `DATABASE_DIRECT_URL`, las dos apuntando a `anticipate_e2e` en el puerto de Compose (5432 en CI; la guía local dice 5433).
  - `TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA` y `TURNSTILE_EXPECTED_HOSTNAME` vacío: el secreto de prueba devuelve `example.com`.
  - `THROTTLE_SUBMIT_LIMIT=1000` y `MAINTENANCE_ENABLED=false`.
  - `OUTBOX_POLLER_ENABLED=true` con `OUTBOX_POLL_INTERVAL_MS=200`, y `MAIL_TRANSPORT=smtp` hacia Mailpit.
  - S3 hacia `anticipate-local`: solo sube objetos.
  - El resto con los valores de `.env.test.example`.
  - El build del E2E usa `PUBLIC_API_BASE_URL=http://127.0.0.1:4010`, `PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA` y `LANDING_API_URL=http://127.0.0.1:4010`.
- **`e2e:prepare`** en la API corre `prisma migrate deploy`, trunca y corre `db:seed`. Lleva una guarda que exige que el nombre de la base en `DATABASE_URL` y en `DATABASE_DIRECT_URL` termine en `_e2e`; si no, sale con 1 sin tocar nada.
- **`anticipate_e2e`**:
  - Se agrega al init de PostgreSQL.
  - El README explica cómo crearla en un volumen existente: `docker compose exec postgres createdb -U anticipate anticipate_e2e`.
- **Specs**:
  - Camino feliz con 2 facturas, con los XML generados por `buildInvoiceXml`. Las fechas se calculan desde hoy en Lima y `recipientRuc` y el porcentaje se leen de `GET /payers`.
  - Emparejado de PDF y .zip.
  - Facturas con problemas antes de enviar.
  - Respuesta perdida: `route.fetch()` y después `route.abort()`; el reintento muestra el mismo código gracias a `Idempotent-Replayed`.
  - 429 y 503 con `Retry-After`, y 403, con `page.route` y sobres validados con `apiErrorEnvelopeSchema`.
  - Correo de confirmación en Mailpit, buscado por un correo único; nunca se vacía Mailpit.
  - Ningún evento `securitypolicyviolation` en ninguna página (listener con `addInitScript`).
  - axe con `wcag2a`, `wcag2aa`, `wcag21aa` y `wcag22aa` en cada estado.
  - Recorrido solo con teclado, con el evento `filechooser`.
  - Móvil: barra fija, menú y pasos fijos.
- **CI**:
  - Job nuevo `e2e`, sin `--affected`:
    1. `docker compose up -d`;
    2. `pnpm install --frozen-lockfile`;
    3. `actions/cache@v6` de `~/.cache/ms-playwright`;
    4. `playwright install --with-deps chromium`;
    5. copiar `.env.e2e.example`;
    6. `docker compose up -d --wait`;
    7. `pnpm turbo run test:e2e`;
    8. si falla, `upload-artifact@v7` con el reporte, las trazas y los logs de Compose;
    9. al final, siempre, `docker compose down --volumes`.
  - `verify` agrega el build de la landing con `LANDING_DATA=fixtures` y `pnpm --filter @anticipate/landing exec wrangler deploy --dry-run`.
- **turbo**: `test:e2e` con `cache: false` y `dependsOn: ["^build", "@anticipate/api#build"]`.
- **README**: sección Landing con el arranque local, las variables, el E2E, el despliegue y el runbook de reconstrucción.
- **STACK v0.9**:
  - D60 a D70 en §13.
  - §4, §5 y §6 al día: CSS propio sin Tailwind, `apps/landing` como está, `[payer].astro` y los textos del diseño.
  - §12 con el despliegue.
  - §14 con los pendientes nuevos.
  - Historial.
- **Bitácora**: una entrada en `REPO/.superpowers/sdd/2026-09-24-base-de-datos-y-api-minima/progress.md`, siempre con la ruta absoluta.

## 5. Review Focus del plan (lo que más puede morder)

1. Envío que se guarda pero cuya respuesta se pierde, más recarga: el reintento debe reusar la clave y mostrar el mismo código, nunca una solicitud duplicada ni "ya está en otra solicitud".
2. Facturas en soles y en dólares, o de dos emisores, en una misma carga: el proveedor elige un grupo; el máximo nunca es 0,00 y la API nunca recibe `MIXED_*`.
3. Zip hostil (bomba, tamaño declarado falso, miles de entradas, rutas `../`): nunca congela la página ni pasa los topes.
4. Turnstile que no carga por CSP o por un bloqueador: aviso en 15 s, nunca un botón muerto.
5. Datos del build viejos o vacíos (caché de turbo, API caída, lista vacía): el build falla, nunca publica.
6. Lo que se pega en monto, celular y DNI (con "S/", "+51", espacios o marcas de WhatsApp) se acepta y llega canónico a la API.
7. Un chunk viejo después de un deploy: la isla se recupera recargando una vez, y el borrador conserva lo escrito.

## 6. Decisiones que registra STACK v0.9

| # | Decisión |
|---|---|
| D60 | Estilos de la landing: tokens CSS, estilos con ámbito de Astro y CSS Modules para las islas; sin Tailwind, shadcn ni `packages/ui` hasta que exista un segundo consumidor (el admin). Reemplaza lo que decía STACK §4, §5 y §6. |
| D61 | La landing consume shared desde `dist`, como la API; shared no publica condición de fuente; su `dev` es `tsdown --watch --no-clean`. |
| D62 | Datos del build: pagadores, topes y versiones legales se leen de la API en el build, validados con los esquemas de shared, con fallo cerrado; turbo sin caché para ese build; fixtures solo con `LANDING_DATA=fixtures` explícito y nunca publicados. Las condiciones y los topes se vuelven a pedir en el navegador. |
| D63 | Lectura de facturas en un Web Worker con el lector de shared y la admisión de `@anticipate/shared/intake` (movida desde la API); .zip con fflate en streaming y topes sobre bytes reales; se envían los mismos bytes que se leyeron. |
| D64 | Protocolo de envío: XHR con `FormData` (Content-Length), Idempotency-Key atada a la huella del contenido y guardada en el borrador, Turnstile `interaction-only` + `execute` con token nuevo por intento, y una tabla exhaustiva de respuestas. |
| D65 | Borrador en IndexedDB (idb-keyval), 72 h, con "No guardar en este dispositivo"; sin consentimientos ni tokens. |
| D66 | `GET /api/v1/legal-documents` publica las versiones vigentes; la landing envía la vigente más reciente de cada tipo según el build y enlaza su URL. |
| D67 | Despliegue en Workers static assets con GitHub Actions (preview por PR en modo demostración, staging en main, producción por tag, reconstrucción manual o nocturna); sin Cache Rule para `/api/*`. |
| D68 | Seguridad de la landing: CSP de Astro con hashes más `_headers`, fuente propia, islas con `client:load`/`client:idle` y recarga única ante un chunk viejo. |
| D69 | Cupo de envíos por defecto de 20 por hora por IP (antes 5): cuentan los intentos fallidos y las oficinas comparten IP. |
| D70 | E2E con Playwright contra la API real en `anticipate_e2e` y la landing servida por `wrangler dev`, con las claves de prueba de Turnstile. |

## 7. Pendientes para Matías y legal (no bloquean el plan; van a STACK §14 y a la bitácora)

1. **Dominio de la landing de factoring.** anticipate.pe es hoy otro producto; se recomienda un subdominio propio. El dominio fija `PUBLIC_SITE_URL`, `CORS_ORIGINS`, `TURNSTILE_EXPECTED_HOSTNAME` y la site key.
2. **Datos de SEA.** ¿Están confirmados `minTermDays` 15 y `maxInvoices` 10? ¿Cuál es el color de acento y el logo con URL propia?
3. **Motivo del financiamiento.** ¿Obligatorio, o un catálogo cerrado? Hoy es opcional en la API y en el diseño.
4. **Contacto desde el +51 954 180 802.** ¿Por qué canal (llamada o WhatsApp Business) y en qué horario?
5. **Solo PDF.** ¿Formulario corto para quien solo tiene el PDF? Hoy la API exige al menos un XML.
6. **Raíz del dominio.** ¿Qué muestra?
7. **Borrador.** ¿Plazo (propuesta: 72 h)? ¿Se guarda por defecto con la opción "No guardar"? ¿Hay que mencionarlo en el aviso de privacidad?
8. **Medición.** ¿Bastan visitas y solicitudes por canal, o se quiere el embudo por paso y los clics de WhatsApp (Worker `/e`)?
9. **Staging e infraestructura.** ¿Staging desde ya? ¿Quién crea la cuenta de Cloudflare y cuándo el repositorio remoto?
10. **iOS.** ¿Hay que soportar iOS 15.4 a 16.3, bajando `build.target`?
11. **Ya registrados.**
    - Preguntas sobre SEA en las FAQ.
    - Detalle de costos.
    - Dirección fiscal.
    - Sección de factoring en la política de privacidad.
    - Términos y Condiciones del factoring. Bloquean producción: sin una versión vigente, todo envío recibe 422 `CONSENT_VERSION_OUTDATED`.
    - Alias privacidad@.
    - Obligación ante la UIF.

## 8. Interfaces entre tareas (nombres y firmas exactas)

Cada escritor usa estas firmas tal cual. Si necesita algo más, lo declara en "Produces" de su tarea y no cambia lo de aquí.

### shared (T1, T2, T3)

```ts
// @anticipate/shared/intake (T1)
export type IntakeFile = { readonly originalname: string; readonly buffer: Uint8Array; readonly size: number }
export type PayerConditions = Pick<PublicPayer, 'slug' | 'ruc' | 'shortName' | 'advancePercent' | 'minTermDays' | 'maxInvoices' | 'allowedCurrencies'>
export function isPdf(bytes: Uint8Array): boolean
export function baseName(name: string): string
export type PdfPairing<T extends IntakeFile> = { pdfByXml: Map<T, T>; problems: Problem[] }
export function pairPdfs<T extends IntakeFile>(xmls: readonly T[], pdfs: readonly T[], maxPdfBytes: number): PdfPairing<T>
export function displayFileName(name: string): string
export type FileNameScreening<T extends IntakeFile> = { accepted: T[]; problems: Problem[] }
export function screenFileNames<T extends IntakeFile>(files: readonly T[]): FileNameScreening<T>
export function oversizedXmlProblem(file: IntakeFile, maxXmlBytes: number): Problem | null
export function unreadableXmlProblem(file: IntakeFile): Problem
export type ReadInvoice<T extends IntakeFile> = { file: T; invoice: ParsedInvoice }
export type XmlFileReading<T extends IntakeFile> = { ok: true; read: ReadInvoice<T> } | { ok: false; problem: Problem }
export function toXmlFileReading<T extends IntakeFile>(file: T, result: ParseResult): XmlFileReading<T>
export function buildValidationContext(payer: PayerConditions, supplierRuc: string | undefined, today: IsoDate): ValidationContext
export type InvoiceGroup = { key: string; currency: Currency; issuerRuc: string; issuerName: string; invoices: ParsedInvoice[]; netPendingTotal: Amount; maxAdvance: Amount }
export function groupInvoicesForSubmission(invoices: readonly ParsedInvoice[], advancePercent: number): InvoiceGroup[]

// @anticipate/shared/text (T2)
export function cleanPasted(text: string): string
export function normalizeEmailInput(text: string): string
// @anticipate/shared/money (T2)
export function parseAmountInput(text: string): Amount | null
export const CURRENCY_SYMBOLS: Readonly<Record<Currency, string>>
export function formatMoney(amount: Amount, currency: Currency): string
// @anticipate/shared/identity (T2)
export const mobileSchema: z.ZodType<string>
export function isValidMobile(text: string): boolean
export function normalizeMobileInput(text: string): string | null
export function formatMobile(nineDigits: string): string
export function normalizeDniInput(text: string): string | null
export function normalizeRucInput(text: string): string | null
// @anticipate/shared/advance-request (T2)
export function sanitizeUtm(params: URLSearchParams): Record<string, string> | undefined
export function sanitizeReferrer(referrer: string): string | undefined
export const CONTACT_TIME_SLOT_PHRASES: Readonly<Record<ContactTimeSlot, string>>
// @anticipate/shared/company (T2)
export const ANTICIPATE_COMPANY: Readonly<{ legalName: string; ruc: string; address: string; phoneDisplay: string; whatsappNumber: string; supportEmail: string; privacyEmail: string }>
export function whatsappUrl(text?: string): string
export function supplierGreeting(payerShortName: string): string
// @anticipate/shared/api (T3)
export const currentLegalDocumentSchema: z.ZodObject<...> // { type: 'TERMS' | 'PERSONAL_DATA'; version: string (1-20); url: string (http/https); publishedAt: string (ISO) }
export const currentLegalDocumentsSchema: z.ZodArray<typeof currentLegalDocumentSchema>
export type CurrentLegalDocument = z.infer<typeof currentLegalDocumentSchema>
```

### landing (T5 a T14)

```ts
// src/lib/build-data/types.ts (T5)
export type LegalLinks = { termsVersion: string; termsUrl: string; privacyVersion: string; privacyUrl: string }
export type BuildData = { payers: PublicPayer[]; intakeLimits: IntakeLimits; legal: LegalLinks }
// src/lib/build-data/fetch.ts (T5), puros; fetchImpl por defecto globalThis.fetch; buildId para ?build=
export function fetchPublicPayers(baseUrl: string, options?: FetchOptions): Promise<PublicPayer[]>
export function fetchIntakeLimits(baseUrl: string, options?: FetchOptions): Promise<IntakeLimits>
export function fetchLegalDocuments(baseUrl: string, options?: FetchOptions): Promise<CurrentLegalDocument[]>
export function pickLegalLinks(documents: readonly CurrentLegalDocument[]): LegalLinks // lanza Error en español si falta un tipo
export type FetchOptions = { fetchImpl?: typeof fetch; buildId?: string; attempts?: number; timeoutMs?: number }
// src/lib/build-data/build-data.server.ts (T5)
export function getBuildData(): Promise<BuildData> // una promesa por build; LANDING_DATA=fixtures lee fixtures.ts
// src/lib/island-config.ts (T5): lo que cada isla recibe como prop serializable
export type IslandConfig = { payer: PublicPayer; intakeLimits: IntakeLimits; legal: LegalLinks; apiBaseUrl: string; turnstileSiteKey: string; siteUrl: string; pageUrl: string }
export function islandConfig(payer: PublicPayer, data: BuildData): IslandConfig
// src/layouts/BaseLayout.astro (T5) Props
type BaseLayoutProps = { title: string; description: string; canonicalPath: string; payer?: PublicPayer; noindex?: boolean; ogImagePath?: string }

// src/content/landing-copy.ts (T6)
export type LandingCopy = { /* todos los textos de las secciones, ya interpolados */ }
export function landingCopy(payer: PublicPayer): LandingCopy

// src/lib/intake/types.ts (T7)
export type FileReading =
  | { kind: 'xml'; name: string; size: number; bytes: ArrayBuffer; result: ParseResult; sourceZip?: string }
  | { kind: 'pdf'; name: string; size: number; bytes: ArrayBuffer; sourceZip?: string }
  | { kind: 'rejected'; name: string; size: number; problem: Problem; sourceZip?: string }
export type IntakeContext = { payer: PayerConditions; limits: IntakeLimits; today: IsoDate }
// src/lib/intake/worker-client.ts (T7)
export type InvoiceReader = { read(files: readonly File[], limits: IntakeLimits): Promise<FileReading[]>; dispose(): void }
export function createInvoiceReader(): InvoiceReader
// src/lib/intake/intake-state.ts (T7)
export type EntryStatus = 'ready' | 'not-eligible' | 'unreadable' | 'duplicate' | 'loose-pdf' | 'oversized' | 'overflow'
export type IntakeEntry = { id: string; kind: 'xml' | 'pdf' | 'rejected'; name: string; size: number; bytes: ArrayBuffer | null; invoice: ParsedInvoice | null; problems: Problem[]; pairedPdfId: string | null; assignedToId: string | null; status: EntryStatus }
export type IntakeState = { readonly entries: readonly IntakeEntry[]; readonly lastRemoved: { entry: IntakeEntry; index: number } | null; readonly chosenGroupKey: string | null; readonly nextId: number }
export type SubmissionFiles = { xml: { name: string; bytes: ArrayBuffer }[]; pdf: { name: string; bytes: ArrayBuffer }[]; company: { ruc: string; legalName: string }; currency: Currency; netPendingTotal: Amount; maxAdvance: Amount; invoiceNumbers: string[] }
export type IntakeView = { entries: readonly IntakeEntry[]; groups: InvoiceGroup[]; chosenGroup: InvoiceGroup | null; overflowNames: string[]; readyCount: number; notSentCount: number; submission: SubmissionFiles | null; bodyTooLarge: boolean; tooManyFiles: boolean; setProblems: Problem[] }
export function emptyIntake(): IntakeState
export function addReadings(state: IntakeState, readings: readonly FileReading[], ctx: IntakeContext): IntakeState
export function removeEntry(state: IntakeState, id: string, ctx: IntakeContext): IntakeState
export function undoRemove(state: IntakeState, ctx: IntakeContext): IntakeState
export function assignPdf(state: IntakeState, pdfId: string, invoiceId: string, ctx: IntakeContext): IntakeState
export function chooseGroup(state: IntakeState, key: string, ctx: IntakeContext): IntakeState
export function replaceEntry(state: IntakeState, id: string, readings: readonly FileReading[], ctx: IntakeContext): IntakeState
export function viewIntake(state: IntakeState, ctx: IntakeContext): IntakeView
// src/lib/intake/problem-text.ts (T7)
export function problemText(problem: Problem, invoice?: ParsedInvoice | null): string

// src/lib/store/intake-store.ts (T8)
export type IntakeAction =
  | { type: 'add'; readings: readonly FileReading[] } | { type: 'remove'; id: string } | { type: 'undo' }
  | { type: 'assign-pdf'; pdfId: string; invoiceId: string } | { type: 'choose-group'; key: string }
  | { type: 'replace'; id: string; readings: readonly FileReading[] } | { type: 'reset' } | { type: 'restore'; state: IntakeState }
export type IntakeStore = { getSnapshot(): IntakeState; subscribe(listener: () => void): () => void; dispatch(action: IntakeAction): void; context(): IntakeContext | null; configure(ctx: IntakeContext): void; readAndAdd(files: readonly File[]): Promise<void>; readAndReplace(id: string, files: readonly File[]): Promise<void>; readingCount(): number }
export const intakeStore: IntakeStore
export function useIntake(): { state: IntakeState; view: IntakeView | null; reading: boolean }
// src/islands/calculator/Calculator.tsx (T8): export default function Calculator(props: { config: IslandConfig })

// src/islands/request-form/form-model.ts (T10; T9 lo consume solo por RequestForm)
export type FormModel = { cavali: CavaliRegistration | null; amountText: string; purpose: string; fullName: string; dniText: string; mobileText: string; emailText: string; isLegalRepresentative: boolean | null; jobTitle: string; contactTimeSlot: ContactTimeSlot | null; acceptTerms: boolean; acceptPrivacy: boolean }
export type FormAction = { type: 'set'; field: keyof FormModel; value: FormModel[keyof FormModel] } | { type: 'reset' } | { type: 'restore'; model: FormModel }
export const initialFormModel: FormModel
export function formReducer(model: FormModel, action: FormAction): FormModel
export type FieldErrors = Partial<Record<FormFieldName, string>>
export type FormFieldName = 'cavali' | 'amount' | 'purpose' | 'fullName' | 'dni' | 'mobile' | 'email' | 'isLegalRepresentative' | 'jobTitle' | 'contactTimeSlot' | 'acceptTerms' | 'acceptPrivacy'
export type SourceInfo = { utm?: Record<string, string>; referrer?: string }
export function buildAdvanceRequestForm(model: FormModel, submission: SubmissionFiles, config: IslandConfig, source: SourceInfo): { ok: true; form: AdvanceRequestForm } | { ok: false; errors: FieldErrors }
export function fieldForIssuePath(path: readonly PropertyKey[]): FormFieldName | null // 'contact.dni' → 'dni', 'financing.requestedAmount' → 'amount', …
// src/islands/request-form/step-status.ts (T10)
export type StepState = 'done' | 'current' | 'todo'
export type StepStatus = { id: 'paso-facturas' | 'paso-adelanto' | 'paso-datos'; number: '01' | '02' | '03'; label: string; shortLabel: string; state: StepState; text: string; missing: number }
export function stepStatuses(model: FormModel, view: IntakeView | null, currency: Currency | null): StepStatus[]
// src/islands/request-form/RequestForm.tsx (T9): export default function RequestForm(props: { config: IslandConfig })

// src/lib/submit/* (T11)
export type SubmitInput = { apiBaseUrl: string; form: AdvanceRequestForm; files: SubmissionFiles; idempotencyKey: string; turnstileToken: string; onProgress?: (loaded: number, total: number) => void; signal?: AbortSignal; timeoutMs?: number }
export type SubmitOutcome =
  | { kind: 'created'; publicCode: string; replayed: boolean; correlationId: string | null }
  | { kind: 'api-error'; status: number; envelope: ApiErrorEnvelope; retryAfterSeconds: number | null; correlationId: string | null }
  | { kind: 'no-response'; reason: 'network' | 'timeout' | 'aborted' | 'gateway' | 'unreadable'; status: number | null }
export function submitAdvanceRequest(input: SubmitInput): Promise<SubmitOutcome>
export type ResponseAction =
  | { kind: 'confirm' } | { kind: 'retry-same-key'; auto: boolean; waitSeconds: number | null; message: string }
  | { kind: 'rate-limited'; waitSeconds: number | null; message: string } | { kind: 'mark-problems'; message: string }
  | { kind: 'field-errors'; message: string } | { kind: 'reduce-files'; message: string } | { kind: 'reload-keep-draft'; message: string }
  | { kind: 'already-received'; message: string } | { kind: 'general-error'; message: string }
export function responseAction(outcome: SubmitOutcome): ResponseAction
export function computeFingerprint(form: AdvanceRequestForm, files: SubmissionFiles): Promise<string>
export type TurnstileHandle = { getToken(timeoutMs?: number): Promise<string>; reset(): void; remove(): void }
export function createTurnstile(container: HTMLElement, siteKey: string): Promise<TurnstileHandle>

// src/lib/draft/* (T12)
export type DraftFile = { name: string; kind: 'xml' | 'pdf'; type: string; lastModified: number; bytes: ArrayBuffer }
export type Draft = { v: 1; savedAt: number; expiresAt: number; model: FormModel; files: DraftFile[]; droppedPdfNames: string[]; chosenGroupKey: string | null; source: SourceInfo; submission: { idempotencyKey: string; fingerprint: string; lastOutcome: 'none' | 'ambiguous' | 'rejected' } | null }
export type DraftRepository = { load(slug: string, now?: number): Promise<Draft | null>; save(slug: string, draft: Draft): Promise<void>; clear(slug: string): Promise<void>; disable(slug: string): Promise<void>; isDisabled(): boolean }
export function createDraftRepository(store?: UseStore): DraftRepository
export const DRAFT_TTL_MS: number // 72 h
export const DRAFT_PDF_BUDGET_BYTES: number // 30 MB
```
