# Fundaciones y `packages/shared` · Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dejar listo el monorepo (pnpm 12, Turborepo, Biome, Vitest, TypeScript 6 estricto, CI) y el paquete `@anticipate/shared` con todo el corazón del negocio testeado: validadores de identidad, dinero sin `float`, fechas de calendario con date-fns, lector de XML UBL, reglas de factura parametrizadas, máquina de estados como datos, esquemas Zod del formulario y del pagador, y reglas de vigencia de documentos.

**Architecture:** `packages/shared` es un paquete isomorfo sin código de servidor ni de navegador: solo tipos, esquemas Zod y funciones puras. Todo valor de negocio variable (RUC del pagador, porcentaje de adelanto, plazo mínimo, máximo de facturas, monedas permitidas, días de vigencia de poder, fecha "hoy") entra como parámetro en un objeto de contexto; nada vive como constante. Cada dominio es una carpeta con su `index.ts` y se expone como subruta del paquete (`@anticipate/shared/invoice`). Los mensajes al usuario se resuelven por código estable (`ProblemCode`) en una tabla en español, lista para más idiomas.

**Tech Stack:** Node 24 LTS, pnpm 12 workspaces con `catalog`, Turborepo 2, TypeScript 6 en modo `strict` (nunca 7.0, ver restricciones), Biome 2.5, Vitest 5 (`projects`), Zod 4, `fast-xml-parser` 5, date-fns 4 con `@date-fns/tz`, `tsdown` para compilar `shared` a ESM con tipos. Versiones verificadas contra el registro npm y la documentación oficial el 2026-09-23 (ver tabla al final).

**Spec:** `docs/STACK.md` (v0.4). Este plan implementa las secciones 4, 5, 9 (modelo de dominio y reglas) y las convenciones de la 12.

## Global Constraints

- **Convención de idioma** (decidida el 2026-09-24, igual que en `anticipate-health-backend` y los portales): identificadores de código en inglés (archivos, funciones, tipos, propiedades, valores de enums, modelos y columnas); español en todo lo que lee una persona (mensajes al usuario, textos, documentación, comentarios y commits). Los términos legales peruanos sin traducción real se quedan como préstamos: `ruc`, `dni`, `sunat`, `sunarp`, `cavali`. El glosario español ↔ inglés vive en STACK.md (Tarea 10) y es la única fuente de nombres de dominio.
- TypeScript en modo `strict` con `noUncheckedIndexedAccess` y `exactOptionalPropertyTypes` en todo el monorepo (STACK §4).
- `packages/shared` no depende de nada del monorepo y no tiene código de servidor ni de navegador (STACK §5). Dependencias de runtime permitidas: `zod`, `fast-xml-parser`, `date-fns`, `@date-fns/tz`. Nada más.
- Montos siempre como texto con dos decimales (`"25000.00"`); nunca `float` (STACK §9, D14). Moneda en su propia propiedad (`PEN`, `USD`).
- Fechas de dominio como texto ISO `YYYY-MM-DD`, sin hora ni zona. `shared` nunca pregunta qué día es hoy: lo recibe. El único helper que convierte un instante en fecha de Lima (`todayIn`) recibe el instante por parámetro.
- Las reglas de factura reciben todo parámetro de negocio por contexto: RUC del pagador, RUC del proveedor, porcentaje de adelanto, plazo mínimo en días, máximo de facturas, monedas permitidas y fecha de hoy. Ninguna constante de negocio en el código.
- Las transiciones de estado viven en `shared` como datos con guardas nombradas; la API calcula los hechos que resuelven las guardas (STACK §9).
- Versiones: se fijan en el `catalog` de `pnpm-workspace.yaml`; ninguna versión escrita a mano en los `package.json`. Pins obligatorios, verificados el 2026-09-23: Node `>=24.15 <27` (24 es el LTS activo, 22 ya está en mantenimiento), pnpm 12.6, **TypeScript 6.0.x instalado como `typescript@npm:@typescript/typescript6`** (7.0 es `latest` pero no tiene API programática, @nestjs/cli 12 exige ~6.0 y @nestjs/swagger 12 excluye 7), Zod 4.6, fast-xml-parser ≥ 5.3.5 (corrige la CVE-2026-25896 de entidades DOCTYPE), date-fns 4, Vitest 5, Biome 2.5, tsdown (tsup está sin mantenimiento).
- `packages/shared` se compila a ESM con tipos usando `tsdown`, sin CJS: NestJS 12 es ESM y Node ≥ 22.12 tiene `require(esm)` estable. Los imports internos llevan extensión `.js`.
- pnpm 12: la configuración vive en `pnpm-workspace.yaml`, no en `.npmrc`. `catalogMode: strict`. Los paquetes con scripts de instalación se aprueban con `pnpm approve-builds`.
- El XML se procesa sin resolver entidades (STACK §11): `processEntities: false`.
- Commits con Conventional Commits, cuerpo en español (STACK §12). Cada tarea termina en un commit.
- Todo archivo nuevo pasa `biome check`, `tsc --noEmit` y `vitest run` antes del commit.

## Review Focus

1. **XML con BOM, declaración `encoding="ISO-8859-1"` o saltos de línea de Windows.** Los sistemas de facturación exportan de todo; el lector debe leerlo igual. Test en la Tarea 5.
2. **XML con prefijos de espacio de nombres distintos (`n1:Invoice`, sin prefijo) o con la ruta legada del RUC (`PartyTaxScheme/CompanyID`).** El mismo comprobante llega con formas distintas según el emisor. Tests en la Tarea 5.
3. **Montos del XML sin dos decimales (`1180.5`, `1180`).** UBL no obliga a dos decimales; el dominio sí. Tests en las Tareas 4 y 5.
4. **Factura con varias cuotas donde una ya venció y otras no.** La regla debe señalar la cuota vencida, no aprobar por la primera futura. Test en la Tarea 6.
5. **La misma factura dos veces en la misma solicitud, o dos facturas de emisores distintos.** Debe rechazarse antes de tocar la base de datos. Test en la Tarea 6.

---

## Glosario de nombres (español del documento → inglés del código)

| Documento | Código | Notas |
|---|---|---|
| Pagador | `Payer`, `payer` | |
| Proveedor | `Supplier`, `supplier` | |
| Solicitud (de adelanto) | `AdvanceRequest`, `advanceRequest` | Evita chocar con `Request` de HTTP |
| Factura | `Invoice`, `invoice` | |
| Cuota | `Installment`, `installment` | |
| Serie y número (`F001-123`) | `seriesNumber` | |
| Emisor, receptor | `issuer`, `recipient` | |
| Forma de pago (contado, crédito) | `paymentTerms`: `CASH`, `CREDIT` | |
| Monto neto pendiente | `netPendingAmount` | |
| Detracción, retención, percepción | `detraction`, `withholding`, `perception` | Términos de SUNAT en inglés |
| Representante legal | `LegalRepresentative` | |
| Documento del proveedor | `SupplierDocument` | |
| DNI del representante, vigencia de poder, contrato marco | `REPRESENTATIVE_ID`, `POWER_OF_ATTORNEY_CERTIFICATE`, `MASTER_AGREEMENT` | |
| Seguimiento | `FollowUp` | |
| Historial de estado | `StatusHistory` | |
| Consentimiento | `Consent` | |
| Archivo | `StoredFile` | `File` choca con el tipo del navegador |
| Auditoría | `AuditLog` | |
| Proforma, cesión, desembolso | `Quote`, `Assignment`, `Disbursement` | |
| Estados de la solicitud | `NEW`, `NO_ANSWER`, `CONTACTED`, `DOCUMENTS_PENDING`, `UNDER_REVIEW`, `QUOTE_SENT`, `APPROVED`, `DISBURSED`, `REJECTED`, `WITHDRAWN` | Orden del documento |
| Motivos de cierre | `NO_RESPONSE`, `SPAM_OR_INVALID`, `SUPPLIER_WITHDREW`, `INVALID_DOCUMENTS`, `INVOICE_NOT_ELIGIBLE`, `UNACCEPTABLE_RISK`, `OTHER` | |
| Roles | `AGENT` (gestor), `ADMIN` | |
| Problema (error de negocio) | `Problem`, `ProblemCode` | |
| Código público `ANT-2026-000123` | `publicCode` | No cambia |

---

## Estructura de archivos

```
anticipate-factoring/
├── .github/workflows/ci.yml            Lint, tipos, tests y build en cada PR y en main
├── .vscode/extensions.json             Recomienda Biome al abrir el repo
├── .editorconfig                       Indentación y finales de línea para cualquier editor
├── .node-version                       Versión de Node para nvm/fnm/volta
├── biome.json                          Linter y formateador de todo el monorepo
├── package.json                        Scripts raíz: lint, typecheck, test, build, verify
├── pnpm-workspace.yaml                 Workspaces + catálogo de versiones (único lugar con versiones)
├── turbo.json                          Grafo de tareas: build de packages antes que apps, caché local
├── tsconfig.json                       Para que el editor entienda los archivos de configuración de la raíz
├── vitest.config.ts                    Corre los tests de todos los paquetes desde la raíz
├── README.md                           Cómo instalar, correr y verificar
├── docs/
│   ├── STACK.md                        El documento vivo (se mueve aquí desde la raíz)
│   └── superpowers/plans/              Este plan y los siguientes
├── apps/                               (vacío; landing, admin y api llegan en los pasos 2 a 4)
└── packages/
    ├── config/                         @anticipate/config
    │   ├── package.json
    │   ├── tsconfig.base.json          Opciones estrictas comunes
    │   ├── tsconfig.library.json       Para paquetes compilados con tsdown (shared, emails)
    │   └── tsconfig.node.json          Para la API (NodeNext, decoradores) — se usa en el paso 2
    └── shared/                         @anticipate/shared
        ├── package.json                exports por dominio, ESM + tipos
        ├── tsconfig.json
        ├── tsdown.config.ts
        ├── vitest.config.ts
        ├── test/fixtures/
        │   └── invoice-credit-pen.xml  XML de referencia con forma legible
        └── src/
            ├── index.ts                Reexporta todos los dominios
            ├── errors/                 Códigos de problema y mensajes en español
            │   ├── index.ts
            │   ├── codes.ts
            │   ├── messages.es.ts
            │   └── problem.ts (+ problem.test.ts)
            ├── identity/               RUC y DNI: validación y esquemas Zod
            │   ├── index.ts
            │   ├── ruc.ts (+ ruc.test.ts)
            │   └── dni.ts (+ dni.test.ts)
            ├── money/                  Monedas y montos como texto, aritmética en céntimos (bigint)
            │   ├── index.ts
            │   ├── currency.ts
            │   └── amount.ts (+ amount.test.ts)
            ├── dates/                  Fechas ISO de calendario con date-fns; "hoy" en Lima con @date-fns/tz
            │   ├── index.ts
            │   └── iso-date.ts (+ iso-date.test.ts)
            ├── invoice/                Códigos SUNAT, factura leída, fábrica de XML, lector UBL, reglas
            │   ├── index.ts
            │   ├── codes.ts
            │   ├── parsed-invoice.ts
            │   ├── build-test-xml.ts   Fábrica de XML para tests (también la usará la landing en modo demo)
            │   ├── ubl-parser.ts (+ ubl-parser.test.ts)
            │   └── rules.ts (+ rules.test.ts)
            ├── advance-request/        Estados, motivos de cierre, transiciones, formulario, código público
            │   ├── index.ts
            │   ├── statuses.ts
            │   ├── close-reasons.ts
            │   ├── transitions.ts (+ transitions.test.ts)
            │   ├── form.ts (+ form.test.ts)
            │   └── public-code.ts (+ public-code.test.ts)
            ├── supplier-document/      Tipos, estados y vigencia de documentos del proveedor
            │   ├── index.ts
            │   └── validity.ts (+ validity.test.ts)
            ├── payer/                  Esquema público del pagador (lo que la landing recibe)
            │   ├── index.ts
            │   └── schema.ts (+ schema.test.ts)
            └── user/                   Roles y jerarquía
                ├── index.ts
                └── roles.ts (+ roles.test.ts)
```

**Principios que aplican a todos los archivos de `shared`**

- Un archivo, una responsabilidad. Los tests van al lado del código (`x.test.ts`) y sus descripciones (`it('...')`) van en español, porque son texto para personas.
- Exportar tipos derivados de constantes `as const`, nunca duplicar listas en un `enum` de TS y en un array.
- Funciones puras: sin `Date.now()`, sin `process.env`, sin `fetch`, sin `window`. La fecha de hoy se recibe por parámetro.
- Toda validación devuelve `Problem` con código estable; el texto sale de `messages.es.ts`. La API y la landing muestran el mensaje; los tests comparan códigos.

---

### Task 1: Raíz del monorepo

**Files:**
- Create: `pnpm-workspace.yaml`, `package.json`, `turbo.json`, `.node-version`, `.editorconfig`, `tsconfig.json`, `biome.json`, `vitest.config.ts`, `.vscode/extensions.json`

**Interfaces:**
- Produces: el catálogo de versiones `catalog:` que todos los `package.json` usan; los scripts raíz `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm verify`.

- [ ] **Step 1: Confirmar Node y pnpm**

Run: `node --version && pnpm --version`
Expected: Node 24.15 o superior (24 es el LTS activo; 22 ya está en mantenimiento). pnpm 12.6 o superior. Si pnpm falta: `corepack enable && corepack prepare pnpm@latest --activate` (Corepack viene con Node 24).

- [ ] **Step 2: Obtener las últimas versiones estables para el catálogo**

Run:
```bash
printf 'typescript (alias 6.x): %s\n' "$(pnpm view @typescript/typescript6 version)"
for p in zod fast-xml-parser date-fns @date-fns/tz vitest @biomejs/biome @types/node tsdown turbo; do
  printf '%s: ^%s\n' "$p" "$(pnpm view "$p" version)"
done
```
Expected: una línea por paquete. TypeScript se instala por el alias `@typescript/typescript6`: la etiqueta `latest` de `typescript` es 7.0, que no tiene API programática y que el CLI de NestJS 12 y @nestjs/swagger rechazan.

- [ ] **Step 3: Crear `pnpm-workspace.yaml`**

```yaml
packages:
  - apps/*
  - packages/*

# pnpm 12: toda la configuración vive aquí; .npmrc queda solo para registro y auth.
catalogMode: strict
autoInstallPeers: true
strictPeerDependencies: false
shamefullyHoist: false

# Único lugar del monorepo donde se fijan versiones. Los package.json usan "catalog:".
catalog:
  typescript: npm:@typescript/typescript6@^<versión del paso 2>
  zod: ^<versión del paso 2>
  fast-xml-parser: ^<versión del paso 2>
  date-fns: ^<versión del paso 2>
  "@date-fns/tz": ^<versión del paso 2>
  vitest: ^<versión del paso 2>
  "@biomejs/biome": ^<versión del paso 2>
  "@types/node": ^<versión del paso 2>
  tsdown: ^<versión del paso 2>
  turbo: ^<versión del paso 2>
```

- [ ] **Step 4: Crear `package.json` raíz**

```json
{
  "name": "anticipate-factoring",
  "private": true,
  "packageManager": "pnpm@<salida exacta de pnpm --version>",
  "engines": { "node": ">=24.15 <27", "pnpm": ">=12.6" },
  "devEngines": {
    "runtime": { "name": "node", "version": "^24.15.0", "onFail": "download" },
    "packageManager": { "name": "pnpm", "version": "^<salida de pnpm --version>", "onFail": "download" }
  },
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "test:watch": "vitest",
    "verify": "pnpm lint && turbo run typecheck test build"
  },
  "devDependencies": {
    "@biomejs/biome": "catalog:",
    "turbo": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```

- [ ] **Step 5: Crear `.node-version` y `.editorconfig`**

`.node-version`:
```
24
```

`.editorconfig`:
```ini
root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 2
insert_final_newline = true
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false
```

- [ ] **Step 6: Crear `biome.json`**

```json
{
  "$schema": "./node_modules/@biomejs/biome/configuration_schema.json",
  "root": true,
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": {
    "includes": ["**", "!**/dist", "!**/node_modules", "!**/.astro", "!**/.next", "!**/.open-next", "!**/.turbo", "!**/coverage"]
  },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "javascript": { "formatter": { "quoteStyle": "single", "semicolons": "asNeeded", "trailingCommas": "all" } },
  "assist": { "actions": { "source": { "organizeImports": "on" } } }
}
```

- [ ] **Step 7: Crear `turbo.json`, `tsconfig.json`, `vitest.config.ts` y `.vscode/extensions.json`**

`turbo.json`:
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**", "!.next/cache/**", ".open-next/**"] },
    "typecheck": { "dependsOn": ["^build"] },
    "test": { "dependsOn": ["^build"] },
    "dev": { "cache": false, "persistent": true }
  }
}
```

`tsconfig.json`:
```json
{
  "extends": "./packages/config/tsconfig.base.json",
  "compilerOptions": { "types": ["node"], "noEmit": true },
  "include": ["vitest.config.ts"]
}
```

`vitest.config.ts` (para `pnpm test:watch` y el editor; CI corre los tests por paquete con turbo):
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
  },
})
```

`.vscode/extensions.json`:
```json
{ "recommendations": ["biomejs.biome"] }
```

- [ ] **Step 8: Instalar y verificar que la raíz funciona vacía**

Run: `pnpm install`
Expected: crea `pnpm-lock.yaml`. Si pnpm avisa de scripts de instalación ignorados, correr `pnpm approve-builds`, aceptar los que liste (típicamente `@biomejs/biome`, `esbuild`, `unrs-resolver`) y volver a instalar; ese comando escribe la lista en `pnpm-workspace.yaml` con la sintaxis correcta.

Run: `pnpm lint && pnpm test`
Expected: `biome check` sin errores; `turbo run test` termina sin tareas (todavía no hay paquetes) y código 0.

- [ ] **Step 9: Commit**

```bash
git add pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json .node-version .editorconfig tsconfig.json biome.json vitest.config.ts .vscode/extensions.json
git commit -m "chore: raíz del monorepo con pnpm 12, Turborepo, Biome y Vitest"
```

### Task 2: `packages/config`, esqueleto de `packages/shared` y dominio `errors`

**Files:**
- Create: `packages/config/package.json`, `packages/config/tsconfig.base.json`, `packages/config/tsconfig.library.json`, `packages/config/tsconfig.node.json`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/tsdown.config.ts`, `packages/shared/vitest.config.ts`, `packages/shared/src/index.ts`
- Create: `packages/shared/src/errors/codes.ts`, `packages/shared/src/errors/messages.es.ts`, `packages/shared/src/errors/problem.ts`, `packages/shared/src/errors/index.ts`
- Test: `packages/shared/src/errors/problem.test.ts`

**Interfaces:**
- Produces: `ProblemCode` (unión de códigos), `Problem = { code, message, invoice?, field? }`, `createProblem(code, extra?)`, `MESSAGES_ES`. Todas las tareas siguientes devuelven `Problem` para señalar errores de negocio.

- [ ] **Step 1: Crear `packages/config`**

`packages/config/package.json`:
```json
{
  "name": "@anticipate/config",
  "version": "0.0.0",
  "private": true,
  "files": ["tsconfig.*.json"]
}
```

`packages/config/tsconfig.base.json`:
```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

`packages/config/tsconfig.library.json`:
```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "rootDir": "${configDir}/src",
    "outDir": "${configDir}/dist"
  }
}
```

`packages/config/tsconfig.node.json` (lo usará la API en el paso 2; se crea ahora para que el preset exista):
```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "verbatimModuleSyntax": false,
    "emitDecoratorMetadata": true,
    "experimentalDecorators": true,
    "types": ["node"]
  }
}
```

- [ ] **Step 2: Crear el esqueleto de `packages/shared`**

`packages/shared/package.json` (solo ESM; `types` va primero en cada entrada de `exports`):
```json
{
  "name": "@anticipate/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "sideEffects": false,
  "files": ["dist"],
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./errors": { "types": "./dist/errors/index.d.ts", "default": "./dist/errors/index.js" },
    "./identity": { "types": "./dist/identity/index.d.ts", "default": "./dist/identity/index.js" },
    "./money": { "types": "./dist/money/index.d.ts", "default": "./dist/money/index.js" },
    "./dates": { "types": "./dist/dates/index.d.ts", "default": "./dist/dates/index.js" },
    "./invoice": { "types": "./dist/invoice/index.d.ts", "default": "./dist/invoice/index.js" },
    "./advance-request": { "types": "./dist/advance-request/index.d.ts", "default": "./dist/advance-request/index.js" },
    "./supplier-document": { "types": "./dist/supplier-document/index.d.ts", "default": "./dist/supplier-document/index.js" },
    "./payer": { "types": "./dist/payer/index.d.ts", "default": "./dist/payer/index.js" },
    "./user": { "types": "./dist/user/index.d.ts", "default": "./dist/user/index.js" }
  },
  "scripts": {
    "build": "tsdown",
    "dev": "tsdown --watch",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@date-fns/tz": "catalog:",
    "date-fns": "catalog:",
    "fast-xml-parser": "catalog:",
    "zod": "catalog:"
  },
  "devDependencies": {
    "@anticipate/config": "workspace:*",
    "@types/node": "catalog:",
    "tsdown": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```

`packages/shared/tsconfig.json` (TypeScript 6 trae `types: []` por defecto, por eso se declara `node`):
```json
{
  "extends": "@anticipate/config/tsconfig.library.json",
  "compilerOptions": { "types": ["node"], "noEmit": true },
  "include": ["src"]
}
```

`packages/shared/tsdown.config.ts`:
```ts
import { defineConfig } from 'tsdown'

const domains = [
  'errors',
  'identity',
  'money',
  'dates',
  'invoice',
  'advance-request',
  'supplier-document',
  'payer',
  'user',
] as const

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    ...Object.fromEntries(domains.map((d) => [`${d}/index`, `src/${d}/index.ts`])),
  },
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  dts: true,
  sourcemap: true,
  clean: true,
})
```

`packages/shared/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'shared',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
```

`packages/shared/src/index.ts` (se irá completando; por ahora solo errores):
```ts
export * from './errors/index.js'
```

- [ ] **Step 3: Escribir el test que falla para `createProblem`**

`packages/shared/src/errors/problem.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { PROBLEM_CODES } from './codes.js'
import { MESSAGES_ES } from './messages.es.js'
import { createProblem } from './problem.js'

describe('createProblem', () => {
  it('devuelve el código y el mensaje en español', () => {
    const p = createProblem('INVALID_RUC', { field: 'ruc' })
    expect(p).toEqual({ code: 'INVALID_RUC', message: 'El RUC no es válido.', field: 'ruc' })
  })

  it('interpola datos en el mensaje', () => {
    const p = createProblem('TOO_MANY_INVOICES', { data: { max: 10 } })
    expect(p.message).toBe('Puedes enviar como máximo 10 facturas por solicitud.')
  })

  it('omite las propiedades opcionales que no se pasan', () => {
    const p = createProblem('NO_INVOICES')
    expect(Object.keys(p)).toEqual(['code', 'message'])
  })

  it('todo código tiene mensaje', () => {
    for (const code of PROBLEM_CODES) {
      expect(MESSAGES_ES[code], code).toBeTypeOf('string')
    }
  })
})
```

- [ ] **Step 4: Correr el test y verificar que falla**

Run: `pnpm install && pnpm --filter @anticipate/shared test`
Expected: FAIL, "Cannot find module './codes.js'" (o equivalente).

- [ ] **Step 5: Implementar códigos, mensajes y `createProblem`**

`packages/shared/src/errors/codes.ts`:
```ts
/** Códigos estables de problemas de negocio. La API y la landing muestran el mensaje; los tests comparan el código. */
export const PROBLEM_CODES = [
  // identidad
  'INVALID_RUC',
  'INVALID_DNI',
  // lectura del XML
  'UNREADABLE_XML',
  'XML_NOT_AN_INVOICE',
  'XML_MISSING_REQUIRED_FIELD',
  // reglas por factura
  'DOCUMENT_TYPE_NOT_ALLOWED',
  'RECIPIENT_IS_NOT_PAYER',
  'ISSUER_IS_NOT_SUPPLIER',
  'CASH_INVOICE',
  'NO_PENDING_AMOUNT',
  'CURRENCY_NOT_ALLOWED',
  'INSTALLMENT_OVERDUE',
  'INSUFFICIENT_TERM',
  // reglas del conjunto
  'NO_INVOICES',
  'TOO_MANY_INVOICES',
  'MIXED_ISSUERS',
  'MIXED_CURRENCIES',
  'DUPLICATE_INVOICE',
  // monto solicitado
  'INVALID_AMOUNT',
  'AMOUNT_EXCEEDS_MAXIMUM',
] as const

export type ProblemCode = (typeof PROBLEM_CODES)[number]
```

`packages/shared/src/errors/messages.es.ts`:
```ts
import type { ProblemCode } from './codes.js'

/** Mensajes para el usuario final. Los marcadores `{nombre}` se reemplazan con `data`. */
export const MESSAGES_ES: Record<ProblemCode, string> = {
  INVALID_RUC: 'El RUC no es válido.',
  INVALID_DNI: 'El DNI debe tener 8 dígitos.',
  UNREADABLE_XML: 'No pudimos leer el archivo XML. Verifica que sea el XML original de la factura.',
  XML_NOT_AN_INVOICE: 'El archivo no es una factura electrónica ({kind}).',
  XML_MISSING_REQUIRED_FIELD: 'El XML no contiene el dato "{field}".',
  DOCUMENT_TYPE_NOT_ALLOWED: 'Solo aceptamos facturas electrónicas (tipo 01). Este comprobante es de tipo {kind}.',
  RECIPIENT_IS_NOT_PAYER: 'La factura no está emitida a {payer}.',
  ISSUER_IS_NOT_SUPPLIER: 'La factura fue emitida por otro RUC ({issuer}), no por el de tu empresa.',
  CASH_INVOICE: 'La factura es al contado; solo podemos adelantar facturas al crédito.',
  NO_PENDING_AMOUNT: 'La factura no declara un monto neto pendiente de pago.',
  CURRENCY_NOT_ALLOWED: 'No trabajamos con la moneda {currency}.',
  INSTALLMENT_OVERDUE: 'La cuota {installment} venció el {date}.',
  INSUFFICIENT_TERM: 'La cuota {installment} vence en menos de {days} días.',
  NO_INVOICES: 'Adjunta al menos una factura.',
  TOO_MANY_INVOICES: 'Puedes enviar como máximo {max} facturas por solicitud.',
  MIXED_ISSUERS: 'Todas las facturas deben ser de la misma empresa emisora.',
  MIXED_CURRENCIES: 'Todas las facturas de una solicitud deben estar en la misma moneda.',
  DUPLICATE_INVOICE: 'La factura {invoice} está repetida en esta solicitud.',
  INVALID_AMOUNT: 'El monto debe ser un número mayor que cero con dos decimales.',
  AMOUNT_EXCEEDS_MAXIMUM: 'El monto solicitado supera el máximo de {max} {currency}.',
}
```

`packages/shared/src/errors/problem.ts`:
```ts
import type { ProblemCode } from './codes.js'
import { MESSAGES_ES } from './messages.es.js'

export type Problem = {
  code: ProblemCode
  message: string
  /** Serie-número de la factura a la que se refiere, si aplica. */
  invoice?: string
  /** Campo del formulario al que se refiere, si aplica. */
  field?: string
}

export type ProblemExtra = {
  invoice?: string
  field?: string
  data?: Record<string, string | number>
}

function interpolate(template: string, data: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, key: string) => {
    const value = data[key]
    return value === undefined ? placeholder : String(value)
  })
}

export function createProblem(code: ProblemCode, extra: ProblemExtra = {}): Problem {
  const problem: Problem = { code, message: interpolate(MESSAGES_ES[code], extra.data) }
  if (extra.invoice !== undefined) problem.invoice = extra.invoice
  if (extra.field !== undefined) problem.field = extra.field
  return problem
}
```

`packages/shared/src/errors/index.ts`:
```ts
export { PROBLEM_CODES, type ProblemCode } from './codes.js'
export { MESSAGES_ES } from './messages.es.js'
export { createProblem, type Problem, type ProblemExtra } from './problem.js'
```

- [ ] **Step 6: Correr tests, tipos, lint y build**

Run: `pnpm --filter @anticipate/shared test && pnpm typecheck && pnpm lint && pnpm build`
Expected: 4 tests PASS; `tsc` sin errores; Biome sin errores; `dist/` con `index.js`, `index.d.ts` y la carpeta `errors/`. Sin `.cjs`.

- [ ] **Step 7: Commit**

```bash
git add packages/config packages/shared pnpm-lock.yaml
git commit -m "feat(shared): esqueleto del paquete y dominio de errores con mensajes en español"
```

---

### Task 3: Dominio `identity` (RUC y DNI)

**Files:**
- Create: `packages/shared/src/identity/ruc.ts`, `packages/shared/src/identity/dni.ts`, `packages/shared/src/identity/index.ts`
- Test: `packages/shared/src/identity/ruc.test.ts`, `packages/shared/src/identity/dni.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `MESSAGES_ES` de la Tarea 2.
- Produces: `isValidRuc(value: string): boolean`, `rucSchema`, `isValidDni(value: string): boolean`, `dniSchema`. El formulario (Tarea 8) y las reglas (Tarea 6) los usan.

- [ ] **Step 1: Escribir los tests que fallan**

`packages/shared/src/identity/ruc.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { isValidRuc, rucSchema } from './ruc.js'

describe('isValidRuc', () => {
  it.each([
    ['20100070970', 'empresa (prefijo 20)'],
    ['20131312955', 'entidad pública (prefijo 20)'],
    ['10467286736', 'persona natural con negocio (prefijo 10)'],
  ])('acepta %s (%s)', (ruc) => {
    expect(isValidRuc(ruc)).toBe(true)
  })

  it.each([
    ['20100070971', 'dígito verificador incorrecto'],
    ['12345678901', 'prefijo no válido'],
    ['2010007097', 'diez dígitos'],
    ['201000709700', 'doce dígitos'],
    ['2010007097A', 'con letra'],
    ['', 'vacío'],
  ])('rechaza %s (%s)', (ruc) => {
    expect(isValidRuc(ruc)).toBe(false)
  })
})

describe('rucSchema', () => {
  it('recorta espacios y acepta un RUC válido', () => {
    expect(rucSchema.parse('  20100070970 ')).toBe('20100070970')
  })

  it('devuelve el mensaje en español cuando es inválido', () => {
    const r = rucSchema.safeParse('20100070971')
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0]?.message).toBe('El RUC no es válido.')
  })
})
```

`packages/shared/src/identity/dni.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { dniSchema, isValidDni } from './dni.js'

describe('isValidDni', () => {
  it('acepta 8 dígitos', () => {
    expect(isValidDni('46728673')).toBe(true)
    expect(isValidDni('00000001')).toBe(true)
  })

  it.each(['4672867', '467286731', '4672867A', ''])('rechaza %s', (dni) => {
    expect(isValidDni(dni)).toBe(false)
  })
})

describe('dniSchema', () => {
  it('recorta espacios', () => {
    expect(dniSchema.parse(' 46728673 ')).toBe('46728673')
  })

  it('devuelve el mensaje en español cuando es inválido', () => {
    const r = dniSchema.safeParse('123')
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0]?.message).toBe('El DNI debe tener 8 dígitos.')
  })
})
```

- [ ] **Step 2: Correr y verificar que fallan**

Run: `pnpm --filter @anticipate/shared test -- identity`
Expected: FAIL por módulos inexistentes.

- [ ] **Step 3: Implementar**

`packages/shared/src/identity/ruc.ts`:
```ts
import { z } from 'zod'
import { MESSAGES_ES } from '../errors/index.js'

/** Pesos del algoritmo módulo 11 de SUNAT para los diez primeros dígitos. */
const WEIGHTS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2] as const

/** Prefijos que SUNAT asigna: 10 persona natural, 15/16/17 otros tipos, 20 persona jurídica. */
const VALID_PREFIXES = new Set(['10', '15', '16', '17', '20'])

export function isValidRuc(value: string): boolean {
  if (!/^\d{11}$/.test(value)) return false
  if (!VALID_PREFIXES.has(value.slice(0, 2))) return false
  const sum = WEIGHTS.reduce((acc, weight, i) => acc + weight * Number(value[i]), 0)
  const remainder = 11 - (sum % 11)
  const checkDigit = remainder === 10 ? 0 : remainder === 11 ? 1 : remainder
  return checkDigit === Number(value[10])
}

export const rucSchema = z
  .string()
  .trim()
  .refine(isValidRuc, { error: MESSAGES_ES.INVALID_RUC })
```

`packages/shared/src/identity/dni.ts`:
```ts
import { z } from 'zod'
import { MESSAGES_ES } from '../errors/index.js'

export function isValidDni(value: string): boolean {
  return /^\d{8}$/.test(value)
}

export const dniSchema = z
  .string()
  .trim()
  .refine(isValidDni, { error: MESSAGES_ES.INVALID_DNI })
```

`packages/shared/src/identity/index.ts`:
```ts
export { dniSchema, isValidDni } from './dni.js'
export { isValidRuc, rucSchema } from './ruc.js'
```

Agregar a `packages/shared/src/index.ts`:
```ts
export * from './identity/index.js'
```

- [ ] **Step 4: Correr tests y verificación completa**

Run: `pnpm --filter @anticipate/shared test && pnpm typecheck && pnpm lint`
Expected: todos PASS, sin errores de tipos ni de lint.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src
git commit -m "feat(shared): validadores de RUC (módulo 11) y DNI con esquemas Zod"
```

---

### Task 4: Dominios `money` y `dates`

**Files:**
- Create: `packages/shared/src/money/currency.ts`, `packages/shared/src/money/amount.ts`, `packages/shared/src/money/index.ts`
- Create: `packages/shared/src/dates/iso-date.ts`, `packages/shared/src/dates/index.ts`
- Test: `packages/shared/src/money/amount.test.ts`, `packages/shared/src/dates/iso-date.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces: `CURRENCIES`, `Currency`, `currencySchema`; `Amount` (texto `"25000.00"`), `amountSchema`, `normalizeAmount(value): Amount | null`, `toCents(a): bigint`, `fromCents(c): Amount`, `sumAmounts(...a): Amount`, `percentOf(a, pct): Amount`, `compareAmounts(a, b): -1 | 0 | 1`; `IsoDate`, `isoDateSchema`, `isIsoDate(v)`, `daysBetween(from, to): number`, `addDaysIso(date, days): IsoDate`, `todayIn(timeZone, now): IsoDate`, `LIMA_TIME_ZONE`.

**Diseño de fechas.** Las fechas del dominio son fechas de calendario (`2026-11-30`), no instantes. date-fns hace la aritmética (`differenceInCalendarDays`, `addDays`, `parseISO`, `isValid`, `formatISO`). `todayIn` convierte un instante en la fecha de calendario de una zona con `TZDate` de `@date-fns/tz`; recibe el instante por parámetro para que `shared` siga siendo puro y testeable. La API y la landing llaman `todayIn(LIMA_TIME_ZONE, new Date())` una sola vez y pasan el resultado como `today`.

- [ ] **Step 1: Escribir los tests que fallan**

`packages/shared/src/money/amount.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import {
  amountSchema,
  compareAmounts,
  fromCents,
  normalizeAmount,
  percentOf,
  sumAmounts,
  toCents,
} from './amount.js'

describe('normalizeAmount', () => {
  it.each([
    ['1180.5', '1180.50'],
    ['1180', '1180.00'],
    ['0.1', '0.10'],
    [1180.5, '1180.50'],
    [' 25000.00 ', '25000.00'],
  ])('convierte %s en %s', (input, expected) => {
    expect(normalizeAmount(input)).toBe(expected)
  })

  it.each(['', 'abc', '-5.00', '1,180.50', '1.234', Number.NaN])('rechaza %s', (input) => {
    expect(normalizeAmount(input)).toBeNull()
  })
})

describe('aritmética en céntimos', () => {
  it('convierte ida y vuelta sin perder precisión', () => {
    expect(toCents('25000.00')).toBe(25_000_00n)
    expect(fromCents(25_000_00n)).toBe('25000.00')
    expect(fromCents(5n)).toBe('0.05')
    expect(fromCents(0n)).toBe('0.00')
  })

  it('suma sin errores de coma flotante', () => {
    expect(sumAmounts('0.10', '0.20')).toBe('0.30')
    expect(sumAmounts('10620.00', '5310.50', '0.01')).toBe('15930.51')
  })

  it('calcula porcentajes redondeando hacia abajo al céntimo', () => {
    expect(percentOf('10620.00', 80)).toBe('8496.00')
    expect(percentOf('100.00', 33.33)).toBe('33.33')
    expect(percentOf('0.01', 50)).toBe('0.00')
  })

  it('compara montos', () => {
    expect(compareAmounts('100.00', '100.00')).toBe(0)
    expect(compareAmounts('99.99', '100.00')).toBe(-1)
    expect(compareAmounts('100.01', '100.00')).toBe(1)
  })
})

describe('amountSchema', () => {
  it('acepta solo texto con dos decimales y mayor que cero', () => {
    expect(amountSchema.safeParse('25000.00').success).toBe(true)
    expect(amountSchema.safeParse('0.00').success).toBe(false)
    expect(amountSchema.safeParse('25000').success).toBe(false)
    expect(amountSchema.safeParse(25000).success).toBe(false)
  })
})
```

`packages/shared/src/dates/iso-date.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { LIMA_TIME_ZONE, addDaysIso, daysBetween, isIsoDate, isoDateSchema, todayIn } from './iso-date.js'

describe('isIsoDate', () => {
  it.each(['2026-09-23', '2024-02-29'])('acepta %s', (v) => {
    expect(isIsoDate(v)).toBe(true)
  })

  it.each(['2026-9-3', '23/09/2026', '2026-13-01', '2023-02-29', '2026-09-23T00:00:00Z', ''])(
    'rechaza %s',
    (v) => {
      expect(isIsoDate(v)).toBe(false)
    },
  )
})

describe('daysBetween', () => {
  it('cuenta días de calendario', () => {
    expect(daysBetween('2026-09-23', '2026-09-23')).toBe(0)
    expect(daysBetween('2026-09-23', '2026-10-08')).toBe(15)
    expect(daysBetween('2026-09-23', '2026-09-22')).toBe(-1)
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1)
  })

  it('lanza si una fecha es inválida', () => {
    expect(() => daysBetween('2026-09-23', '2026-13-01')).toThrow()
  })
})

describe('addDaysIso', () => {
  it('suma días de calendario cruzando mes y año', () => {
    expect(addDaysIso('2026-09-01', 90)).toBe('2026-11-30')
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01')
  })
})

describe('todayIn', () => {
  it('devuelve la fecha de calendario de Lima para un instante dado', () => {
    // 2026-09-24T03:30:00Z es 2026-09-23 22:30 en Lima (UTC-5, sin horario de verano)
    expect(todayIn(LIMA_TIME_ZONE, new Date('2026-09-24T03:30:00Z'))).toBe('2026-09-23')
    expect(todayIn(LIMA_TIME_ZONE, new Date('2026-09-24T05:00:00Z'))).toBe('2026-09-24')
    expect(todayIn('UTC', new Date('2026-09-24T03:30:00Z'))).toBe('2026-09-24')
  })
})

describe('isoDateSchema', () => {
  it('rechaza con mensaje en español', () => {
    const r = isoDateSchema.safeParse('23/09/2026')
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0]?.message).toBe('La fecha debe tener el formato AAAA-MM-DD.')
  })
})
```

- [ ] **Step 2: Correr y verificar que fallan**

Run: `pnpm --filter @anticipate/shared test -- money dates`
Expected: FAIL por módulos inexistentes.

- [ ] **Step 3: Implementar `money`**

`packages/shared/src/money/currency.ts`:
```ts
import { z } from 'zod'

/** Monedas que el sistema sabe representar. Cuáles acepta cada pagador es un dato de contexto, no una constante. */
export const CURRENCIES = ['PEN', 'USD'] as const
export type Currency = (typeof CURRENCIES)[number]
export const currencySchema = z.enum(CURRENCIES)
```

`packages/shared/src/money/amount.ts`:
```ts
import { z } from 'zod'
import { MESSAGES_ES } from '../errors/index.js'

/** Monto como texto con exactamente dos decimales, por ejemplo "25000.00". Nunca `number`. */
export type Amount = string

const AMOUNT_FORMAT = /^\d{1,13}\.\d{2}$/

/** Acepta lo que venga de un XML o de un input y lo lleva a `Amount`. Devuelve null si no es un número no negativo. */
export function normalizeAmount(value: string | number): Amount | null {
  const text = typeof value === 'number' ? (Number.isFinite(value) ? value.toString() : '') : value.trim()
  const parts = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(text)
  if (!parts) return null
  const whole = parts[1] ?? '0'
  const decimals = (parts[2] ?? '').padEnd(2, '0')
  return `${whole}.${decimals}`
}

export function toCents(amount: Amount): bigint {
  const [whole = '0', decimals = '00'] = amount.split('.')
  return BigInt(whole) * 100n + BigInt(decimals.padEnd(2, '0').slice(0, 2))
}

export function fromCents(cents: bigint): Amount {
  const text = cents.toString().padStart(3, '0')
  return `${text.slice(0, -2)}.${text.slice(-2)}`
}

export function sumAmounts(...amounts: Amount[]): Amount {
  return fromCents(amounts.reduce((acc, a) => acc + toCents(a), 0n))
}

/** `pct` en escala 0 a 100, con hasta dos decimales (80, 33.33). Redondea hacia abajo al céntimo. */
export function percentOf(amount: Amount, pct: number): Amount {
  const pctInHundredths = BigInt(Math.round(pct * 100))
  return fromCents((toCents(amount) * pctInHundredths) / 10_000n)
}

export function compareAmounts(a: Amount, b: Amount): -1 | 0 | 1 {
  const ca = toCents(a)
  const cb = toCents(b)
  return ca < cb ? -1 : ca > cb ? 1 : 0
}

/** Monto ingresado por una persona: dos decimales obligatorios y mayor que cero. */
export const amountSchema = z
  .string()
  .trim()
  .refine((v) => AMOUNT_FORMAT.test(v) && toCents(v) > 0n, { error: MESSAGES_ES.INVALID_AMOUNT })
```

`packages/shared/src/money/index.ts`:
```ts
export {
  type Amount,
  amountSchema,
  compareAmounts,
  fromCents,
  normalizeAmount,
  percentOf,
  sumAmounts,
  toCents,
} from './amount.js'
export { CURRENCIES, type Currency, currencySchema } from './currency.js'
```

- [ ] **Step 4: Implementar `dates`**

`packages/shared/src/dates/iso-date.ts`:
```ts
import { TZDate } from '@date-fns/tz'
import { addDays, differenceInCalendarDays, format, formatISO, isValid, parseISO } from 'date-fns'
import { z } from 'zod'

/** Fecha de calendario sin hora ni zona: "2026-09-23". */
export type IsoDate = string

/** Zona horaria de operación. Perú no tiene horario de verano. */
export const LIMA_TIME_ZONE = 'America/Lima'

const ISO_DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/

function parse(date: IsoDate): Date {
  if (!ISO_DATE_FORMAT.test(date)) throw new Error(`Fecha inválida: ${date}`)
  const parsed = parseISO(date)
  if (!isValid(parsed) || formatISO(parsed, { representation: 'date' }) !== date) {
    throw new Error(`Fecha inválida: ${date}`)
  }
  return parsed
}

export function isIsoDate(value: string): boolean {
  try {
    parse(value)
    return true
  } catch {
    return false
  }
}

/** Días de calendario de `from` a `to`. Negativo si `to` es anterior. Lanza si alguna fecha es inválida. */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return differenceInCalendarDays(parse(to), parse(from))
}

export function addDaysIso(date: IsoDate, days: number): IsoDate {
  return formatISO(addDays(parse(date), days), { representation: 'date' })
}

/** Fecha de calendario de `now` vista desde `timeZone`. `now` se recibe por parámetro: shared no consulta el reloj. */
export function todayIn(timeZone: string, now: Date): IsoDate {
  return format(new TZDate(now, timeZone), 'yyyy-MM-dd')
}

export const isoDateSchema = z
  .string()
  .trim()
  .refine(isIsoDate, { error: 'La fecha debe tener el formato AAAA-MM-DD.' })
```

`packages/shared/src/dates/index.ts`:
```ts
export { LIMA_TIME_ZONE, addDaysIso, daysBetween, type IsoDate, isIsoDate, isoDateSchema, todayIn } from './iso-date.js'
```

Agregar a `packages/shared/src/index.ts`:
```ts
export * from './money/index.js'
export * from './dates/index.js'
```

- [ ] **Step 5: Correr tests y verificación completa**

Run: `pnpm --filter @anticipate/shared test && pnpm typecheck && pnpm lint`
Expected: todos PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src
git commit -m "feat(shared): montos como texto con aritmética en céntimos y fechas de calendario con date-fns"
```

---

### Task 5: Dominio `invoice` · códigos, factura leída, fábrica de XML y lector UBL

**Files:**
- Create: `packages/shared/src/invoice/codes.ts`, `packages/shared/src/invoice/parsed-invoice.ts`, `packages/shared/src/invoice/build-test-xml.ts`, `packages/shared/src/invoice/ubl-parser.ts`, `packages/shared/src/invoice/index.ts`
- Create: `packages/shared/test/fixtures/invoice-credit-pen.xml`
- Test: `packages/shared/src/invoice/ubl-parser.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `Amount`, `normalizeAmount` (Tarea 4); `IsoDate`, `isIsoDate` (Tarea 4); `createProblem`, `Problem` (Tarea 2).
- Produces: `DOCUMENT_TYPE`, `DOCUMENT_TYPE_NAMES`, `PAYMENT_TERMS`, `PaymentTerms`; `ParsedInvoice`, `Installment`, `parsedInvoiceSchema`; `buildInvoiceXml(options)`, `buildCdrXml()`, `DEFAULT_TEST_XML`; `decodeXml(bytes: Uint8Array): string`; `parseUblInvoice(xml: string): ParseResult` con `ParseResult = { ok: true; invoice: ParsedInvoice } | { ok: false; problem: Problem }`. La Tarea 6 (reglas) consume `ParsedInvoice`.

**Contexto para quien implementa.** La factura electrónica peruana es un XML UBL 2.1 firmado. Los datos que necesitamos y dónde viven (rutas sin prefijos de espacio de nombres, porque el lector los elimina):

| Dato | Ruta |
|---|---|
| Serie y número (`F001-123`) | `Invoice.ID` |
| Fecha de emisión | `Invoice.IssueDate` |
| Tipo de comprobante (`01` factura, `03` boleta) | `Invoice.InvoiceTypeCode` |
| Moneda | `Invoice.DocumentCurrencyCode` |
| RUC y razón social del emisor | `Invoice.AccountingSupplierParty.Party.PartyIdentification.ID` (atributo `schemeID="6"`) y `…Party.PartyLegalEntity.RegistrationName`. Ruta legada que aún usan algunos emisores: `…Party.PartyTaxScheme.CompanyID` y `…PartyTaxScheme.RegistrationName` |
| RUC y razón social del receptor | igual, bajo `AccountingCustomerParty` |
| Total a pagar | `Invoice.LegalMonetaryTotal.PayableAmount` |
| Forma de pago (RS 193-2020) | `Invoice.PaymentTerms[]` con `ID = FormaPago` y `PaymentMeansID = Contado` o `Credito`; si es crédito, `Amount` es el **monto neto pendiente de pago** |
| Cuotas | `Invoice.PaymentTerms[]` con `ID = FormaPago` y `PaymentMeansID = Cuota001…`, con `Amount` y `PaymentDueDate` |
| Detracción | `Invoice.PaymentTerms[]` con `ID = Detraccion`, `PaymentPercent` y `Amount` |
| Firma | existe `Invoice.UBLExtensions…Signature` |

Un CDR (constancia de recepción de SUNAT) tiene raíz `ApplicationResponse`; una nota de crédito, `CreditNote`. Ninguna es factura. La retención del IGV no va en `PaymentTerms` sino en `Invoice.AllowanceCharge` con código 62 del catálogo 53 (verificado en la guía de SUNAT); se lee en una fase posterior porque el neto pendiente ya viene descontado. La forma de pago es obligatoria solo en facturas emitidas desde el 2021-09-01 (RS 042-2021): una factura anterior sin `FormaPago` no tiene neto pendiente declarado y las reglas la rechazan, que es lo correcto para factoring. Los literales del XML (`FormaPago`, `Credito`, `Cuota001`) son de SUNAT y no se traducen.

- [ ] **Step 1: Códigos y forma de la factura leída**

`packages/shared/src/invoice/codes.ts`:
```ts
/** Catálogo 01 de SUNAT: tipo de comprobante. */
export const DOCUMENT_TYPE = {
  INVOICE: '01',
  RECEIPT: '03',
  CREDIT_NOTE: '07',
  DEBIT_NOTE: '08',
} as const
export type DocumentType = (typeof DOCUMENT_TYPE)[keyof typeof DOCUMENT_TYPE]

/** Nombres en español para mensajes al usuario. */
export const DOCUMENT_TYPE_NAMES: Record<string, string> = {
  '01': 'factura',
  '03': 'boleta de venta',
  '07': 'nota de crédito',
  '08': 'nota de débito',
}

export const PAYMENT_TERMS = ['CASH', 'CREDIT'] as const
export type PaymentTerms = (typeof PAYMENT_TERMS)[number]
```

`packages/shared/src/invoice/parsed-invoice.ts`:
```ts
import { z } from 'zod'
import { isoDateSchema } from '../dates/index.js'
import { PAYMENT_TERMS } from './codes.js'

const parsedAmountSchema = z.string().regex(/^\d{1,13}\.\d{2}$/)

export const installmentSchema = z.object({
  id: z.string().min(1),
  amount: parsedAmountSchema,
  dueDate: isoDateSchema,
})
export type Installment = z.infer<typeof installmentSchema>

/** Lo que el lector extrae de un XML. Es la forma que viaja entre landing, API y admin. */
export const parsedInvoiceSchema = z.object({
  documentType: z.string().min(1),
  seriesNumber: z.string().min(1),
  issueDate: isoDateSchema,
  currency: z.string().length(3),
  issuerRuc: z.string().min(1),
  issuerName: z.string(),
  recipientRuc: z.string().min(1),
  recipientName: z.string().nullable(),
  /** Total a pagar del comprobante. Puede ser 0.00 en casos raros; por eso no usa amountSchema. */
  total: parsedAmountSchema,
  paymentTerms: z.enum(PAYMENT_TERMS).nullable(),
  /** Solo al crédito: monto neto pendiente de pago declarado en el XML (ya descuenta detracción o retención). */
  netPendingAmount: parsedAmountSchema.nullable(),
  installments: z.array(installmentSchema),
  detraction: z.object({ percent: z.number().min(0).max(100), amount: parsedAmountSchema }).nullable(),
  signed: z.boolean(),
})
export type ParsedInvoice = z.infer<typeof parsedInvoiceSchema>
```

- [ ] **Step 2: Fábrica de XML de prueba**

`packages/shared/src/invoice/build-test-xml.ts`:
```ts
/**
 * Construye XML UBL 2.1 con la forma de una factura electrónica de SUNAT, para tests y para el modo
 * demostración de la landing. No es un XML válido ante SUNAT (no está firmado de verdad).
 */
export type TestInstallment = { id: string; amount: string; dueDate: string }

export type TestXmlOptions = {
  root?: 'Invoice' | 'CreditNote' | 'ApplicationResponse'
  /** Prefijos de espacio de nombres. `''` produce elementos sin prefijo. */
  prefixes?: { cbc: string; cac: string }
  documentType?: string
  seriesNumber?: string
  issueDate?: string
  currency?: string
  issuerRuc?: string
  issuerName?: string
  recipientRuc?: string
  recipientName?: string | null
  total?: string
  paymentTerms?: 'Contado' | 'Credito' | null
  netPendingAmount?: string | null
  installments?: TestInstallment[]
  detraction?: { percent: string; amount: string } | null
  signed?: boolean
  /** Emite el RUC por la ruta legada PartyTaxScheme/CompanyID en vez de PartyIdentification/ID. */
  legacyRucPath?: boolean
  bom?: boolean
  declaredEncoding?: string
  windowsLineEndings?: boolean
  /** Elementos a omitir, para probar datos obligatorios ausentes. */
  omit?: Array<'ID' | 'IssueDate' | 'DocumentCurrencyCode' | 'InvoiceTypeCode' | 'PayableAmount'>
}

export const DEFAULT_TEST_XML = {
  root: 'Invoice',
  prefixes: { cbc: 'cbc', cac: 'cac' },
  documentType: '01',
  seriesNumber: 'F001-123',
  issueDate: '2026-09-01',
  currency: 'PEN',
  issuerRuc: '20100070970',
  issuerName: 'PROVEEDOR EJEMPLO S.A.C.',
  recipientRuc: '20131312955',
  recipientName: 'SERVICIOS ENERGETICOS AMBIENTALES S.A.',
  total: '11800.00',
  paymentTerms: 'Credito',
  netPendingAmount: '10620.00',
  installments: [{ id: 'Cuota001', amount: '10620.00', dueDate: '2026-11-30' }],
  detraction: { percent: '10', amount: '1180.00' },
  signed: true,
  legacyRucPath: false,
  bom: false,
  declaredEncoding: 'UTF-8',
  windowsLineEndings: false,
  omit: [],
} as const satisfies Required<TestXmlOptions>

export function buildInvoiceXml(options: TestXmlOptions = {}): string {
  const o = { ...DEFAULT_TEST_XML, ...options }
  const cbc = (t: string) => (o.prefixes.cbc ? `${o.prefixes.cbc}:${t}` : t)
  const cac = (t: string) => (o.prefixes.cac ? `${o.prefixes.cac}:${t}` : t)
  const el = (name: string, content: string, attributes = ''): string => `<${name}${attributes}>${content}</${name}>`
  const omitted = (name: (typeof o.omit)[number]) => o.omit.includes(name)
  const money = (name: string, value: string) => el(cbc(name), value, ` currencyID="${o.currency}"`)

  const party = (role: 'AccountingSupplierParty' | 'AccountingCustomerParty', ruc: string, name: string | null) =>
    el(
      cac(role),
      el(
        cac('Party'),
        o.legacyRucPath
          ? el(
              cac('PartyTaxScheme'),
              (name === null ? '' : el(cbc('RegistrationName'), name)) + el(cbc('CompanyID'), ruc, ' schemeID="6"'),
            )
          : el(cac('PartyIdentification'), el(cbc('ID'), ruc, ' schemeID="6"')) +
              (name === null ? '' : el(cac('PartyLegalEntity'), el(cbc('RegistrationName'), name))),
      ),
    )

  const paymentTermsBlocks: string[] = []
  if (o.detraction) {
    paymentTermsBlocks.push(
      el(
        cac('PaymentTerms'),
        el(cbc('ID'), 'Detraccion') +
          el(cbc('PaymentMeansID'), '001') +
          el(cbc('PaymentPercent'), o.detraction.percent) +
          money('Amount', o.detraction.amount),
      ),
    )
  }
  if (o.paymentTerms) {
    paymentTermsBlocks.push(
      el(
        cac('PaymentTerms'),
        el(cbc('ID'), 'FormaPago') +
          el(cbc('PaymentMeansID'), o.paymentTerms) +
          (o.paymentTerms === 'Credito' && o.netPendingAmount !== null ? money('Amount', o.netPendingAmount) : ''),
      ),
    )
  }
  for (const i of o.installments) {
    paymentTermsBlocks.push(
      el(
        cac('PaymentTerms'),
        el(cbc('ID'), 'FormaPago') +
          el(cbc('PaymentMeansID'), i.id) +
          money('Amount', i.amount) +
          el(cbc('PaymentDueDate'), i.dueDate),
      ),
    )
  }

  const signature = o.signed
    ? el(
        'ext:UBLExtensions',
        el('ext:UBLExtension', el('ext:ExtensionContent', el('ds:Signature', el('ds:SignatureValue', 'ZmlybWE='), ' Id="SignSUNAT"'))),
      )
    : ''

  const typeTag = o.root === 'CreditNote' ? 'CreditNoteTypeCode' : 'InvoiceTypeCode'
  const body = [
    signature,
    el(cbc('UBLVersionID'), '2.1'),
    el(cbc('CustomizationID'), '2.0'),
    omitted('ID') ? '' : el(cbc('ID'), o.seriesNumber),
    omitted('IssueDate') ? '' : el(cbc('IssueDate'), o.issueDate),
    omitted('InvoiceTypeCode') ? '' : el(cbc(typeTag), o.documentType, ' listID="0101"'),
    omitted('DocumentCurrencyCode') ? '' : el(cbc('DocumentCurrencyCode'), o.currency),
    party('AccountingSupplierParty', o.issuerRuc, o.issuerName),
    party('AccountingCustomerParty', o.recipientRuc, o.recipientName),
    ...paymentTermsBlocks,
    el(
      cac('LegalMonetaryTotal'),
      money('TaxInclusiveAmount', o.total) + (omitted('PayableAmount') ? '' : money('PayableAmount', o.total)),
    ),
  ].join('\n  ')

  const namespaces = [
    `xmlns="urn:oasis:names:specification:ubl:schema:xsd:${o.root}-2"`,
    'xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"',
    'xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"',
    'xmlns:ds="http://www.w3.org/2000/09/xmldsig#"',
    'xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"',
  ]
  for (const p of [o.prefixes.cbc, o.prefixes.cac]) {
    if (p && p !== 'cbc' && p !== 'cac') namespaces.push(`xmlns:${p}="urn:example:${p}"`)
  }

  let xml = `<?xml version="1.0" encoding="${o.declaredEncoding}"?>\n<${o.root} ${namespaces.join(' ')}>\n  ${body}\n</${o.root}>\n`
  if (o.windowsLineEndings) xml = xml.replace(/\n/g, '\r\n')
  if (o.bom) xml = `﻿${xml}`
  return xml
}

/** Constancia de recepción (CDR) de SUNAT: no es una factura. */
export function buildCdrXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ApplicationResponse xmlns="urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2"',
    '  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">',
    '  <cbc:ID>R-F001-123</cbc:ID>',
    '  <cbc:ResponseDate>2026-09-01</cbc:ResponseDate>',
    '</ApplicationResponse>',
    '',
  ].join('\n')
}
```

Crear `packages/shared/test/fixtures/invoice-credit-pen.xml` con el resultado de `buildInvoiceXml()` sin opciones. Se genera una vez con este comando y se commitea, para que una persona pueda abrirlo y ver la forma:

Run: `pnpm --filter @anticipate/shared exec tsx -e "import('./src/invoice/build-test-xml.ts').then(m => process.stdout.write(m.buildInvoiceXml()))" > packages/shared/test/fixtures/invoice-credit-pen.xml`
(Si `tsx` no está instalado: `pnpm add -Dw tsx` y agregarlo al catálogo. Es solo para este paso y para scripts de desarrollo.)

- [ ] **Step 3: Escribir los tests del lector que fallan**

`packages/shared/src/invoice/ubl-parser.test.ts`:
```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildCdrXml, buildInvoiceXml } from './build-test-xml.js'
import { decodeXml, parseUblInvoice } from './ubl-parser.js'

function parseOk(xml: string) {
  const r = parseUblInvoice(xml)
  if (!r.ok) throw new Error(`Se esperaba lectura correcta: ${r.problem.code}`)
  return r.invoice
}

function parseError(xml: string) {
  const r = parseUblInvoice(xml)
  if (r.ok) throw new Error('Se esperaba un problema')
  return r.problem
}

describe('parseUblInvoice · factura al crédito', () => {
  const inv = parseOk(buildInvoiceXml())

  it('lee identificación, fechas y moneda', () => {
    expect(inv.documentType).toBe('01')
    expect(inv.seriesNumber).toBe('F001-123')
    expect(inv.issueDate).toBe('2026-09-01')
    expect(inv.currency).toBe('PEN')
  })

  it('lee emisor y receptor', () => {
    expect(inv.issuerRuc).toBe('20100070970')
    expect(inv.issuerName).toBe('PROVEEDOR EJEMPLO S.A.C.')
    expect(inv.recipientRuc).toBe('20131312955')
    expect(inv.recipientName).toBe('SERVICIOS ENERGETICOS AMBIENTALES S.A.')
  })

  it('lee total, forma de pago, neto pendiente, cuotas y detracción', () => {
    expect(inv.total).toBe('11800.00')
    expect(inv.paymentTerms).toBe('CREDIT')
    expect(inv.netPendingAmount).toBe('10620.00')
    expect(inv.installments).toEqual([{ id: 'Cuota001', amount: '10620.00', dueDate: '2026-11-30' }])
    expect(inv.detraction).toEqual({ percent: 10, amount: '1180.00' })
    expect(inv.signed).toBe(true)
  })

  it('lee el fixture estático igual que el XML generado', () => {
    const fixture = readFileSync(new URL('../../test/fixtures/invoice-credit-pen.xml', import.meta.url), 'utf8')
    expect(parseOk(fixture)).toEqual(inv)
  })
})

describe('parseUblInvoice · variantes', () => {
  it('factura al contado: sin neto pendiente ni cuotas', () => {
    const inv = parseOk(buildInvoiceXml({ paymentTerms: 'Contado', netPendingAmount: null, installments: [] }))
    expect(inv.paymentTerms).toBe('CASH')
    expect(inv.netPendingAmount).toBeNull()
    expect(inv.installments).toEqual([])
  })

  it('sin bloque de forma de pago: paymentTerms null', () => {
    const inv = parseOk(buildInvoiceXml({ paymentTerms: null, installments: [] }))
    expect(inv.paymentTerms).toBeNull()
  })

  it('varias cuotas', () => {
    const installments = [
      { id: 'Cuota001', amount: '5000.00', dueDate: '2026-10-30' },
      { id: 'Cuota002', amount: '5620.00', dueDate: '2026-11-30' },
    ]
    expect(parseOk(buildInvoiceXml({ installments })).installments).toEqual(installments)
  })

  it('sin detracción ni razón social del receptor', () => {
    const inv = parseOk(buildInvoiceXml({ detraction: null, recipientName: null }))
    expect(inv.detraction).toBeNull()
    expect(inv.recipientName).toBeNull()
  })

  it('normaliza montos sin dos decimales', () => {
    const inv = parseOk(buildInvoiceXml({ total: '11800.5', netPendingAmount: '10620' }))
    expect(inv.total).toBe('11800.50')
    expect(inv.netPendingAmount).toBe('10620.00')
  })

  it('no firmada', () => {
    expect(parseOk(buildInvoiceXml({ signed: false })).signed).toBe(false)
  })

  it('lee una boleta (tipo 03) sin rechazarla; la regla de tipo decide después', () => {
    expect(parseOk(buildInvoiceXml({ documentType: '03' })).documentType).toBe('03')
  })
})

describe('parseUblInvoice · robustez de formato', () => {
  it('tolera BOM y finales de línea de Windows', () => {
    const inv = parseOk(buildInvoiceXml({ bom: true, windowsLineEndings: true }))
    expect(inv.seriesNumber).toBe('F001-123')
  })

  it('tolera elementos sin prefijo de espacio de nombres', () => {
    const inv = parseOk(buildInvoiceXml({ prefixes: { cbc: '', cac: '' } }))
    expect(inv.issuerRuc).toBe('20100070970')
  })

  it('tolera prefijos distintos de cbc/cac', () => {
    const inv = parseOk(buildInvoiceXml({ prefixes: { cbc: 'n1', cac: 'n2' } }))
    expect(inv.netPendingAmount).toBe('10620.00')
  })

  it('tolera la ruta legada del RUC (PartyTaxScheme/CompanyID)', () => {
    const inv = parseOk(buildInvoiceXml({ legacyRucPath: true }))
    expect(inv.issuerRuc).toBe('20100070970')
    expect(inv.recipientRuc).toBe('20131312955')
    expect(inv.issuerName).toBe('PROVEEDOR EJEMPLO S.A.C.')
  })
})

describe('parseUblInvoice · errores', () => {
  it('XML malformado', () => {
    expect(parseError('<Invoice><cbc:ID>F001-1</Invoice>').code).toBe('UNREADABLE_XML')
  })

  it('texto que no es XML', () => {
    expect(parseError('%PDF-1.7 ...').code).toBe('UNREADABLE_XML')
  })

  it('CDR de SUNAT', () => {
    const p = parseError(buildCdrXml())
    expect(p.code).toBe('XML_NOT_AN_INVOICE')
    expect(p.message).toContain('constancia de recepción')
  })

  it('nota de crédito', () => {
    const p = parseError(buildInvoiceXml({ root: 'CreditNote' }))
    expect(p.code).toBe('XML_NOT_AN_INVOICE')
    expect(p.message).toContain('nota de crédito')
  })

  it.each([
    ['ID', 'serie y número'],
    ['IssueDate', 'fecha de emisión'],
    ['InvoiceTypeCode', 'tipo de comprobante'],
    ['DocumentCurrencyCode', 'moneda'],
    ['PayableAmount', 'total'],
  ] as const)('falta %s', (element, name) => {
    const p = parseError(buildInvoiceXml({ omit: [element] }))
    expect(p.code).toBe('XML_MISSING_REQUIRED_FIELD')
    expect(p.message).toContain(name)
  })

  it('no resuelve entidades externas', () => {
    const xml = buildInvoiceXml()
      .replace('<?xml version="1.0" encoding="UTF-8"?>', '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>')
      .replace('F001-123', '&xxe;')
    const r = parseUblInvoice(xml)
    if (r.ok) expect(r.invoice.seriesNumber).not.toContain('root:')
  })
})

describe('decodeXml', () => {
  it('decodifica UTF-8 con BOM', () => {
    const bytes = new TextEncoder().encode('﻿<?xml version="1.0" encoding="UTF-8"?><a>Ñ</a>')
    expect(decodeXml(bytes)).toContain('<a>Ñ</a>')
  })

  it('respeta la codificación declarada (ISO-8859-1)', () => {
    const text = '<?xml version="1.0" encoding="ISO-8859-1"?><a>Ñ</a>'
    const bytes = Uint8Array.from(text, (ch) => ch.charCodeAt(0))
    expect(decodeXml(bytes)).toContain('<a>Ñ</a>')
  })
})
```

- [ ] **Step 4: Correr y verificar que fallan**

Run: `pnpm --filter @anticipate/shared test -- invoice`
Expected: FAIL, "Cannot find module './ubl-parser.js'".

- [ ] **Step 5: Implementar el lector**

`packages/shared/src/invoice/ubl-parser.ts`:
```ts
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { isIsoDate } from '../dates/index.js'
import { type Problem, createProblem } from '../errors/index.js'
import { normalizeAmount } from '../money/index.js'
import type { PaymentTerms } from './codes.js'
import { type Installment, type ParsedInvoice, parsedInvoiceSchema } from './parsed-invoice.js'

export type ParseResult = { ok: true; invoice: ParsedInvoice } | { ok: false; problem: Problem }

const TEXT = '#text'

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: TEXT,
  removeNSPrefix: true,
  processEntities: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
})

type Node = string | { [key: string]: unknown } | undefined

function text(node: unknown): string | undefined {
  if (typeof node === 'string') return node
  if (node && typeof node === 'object' && TEXT in node) {
    const t = (node as Record<string, unknown>)[TEXT]
    return typeof t === 'string' ? t : undefined
  }
  return undefined
}

function asList<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function path(root: unknown, ...steps: string[]): unknown {
  let current: unknown = root
  for (const step of steps) {
    if (!current || typeof current !== 'object') return undefined
    current = asList((current as Record<string, unknown>)[step])[0]
  }
  return current
}

/** Nombres en español para el mensaje XML_NOT_AN_INVOICE. */
const ROOT_KINDS: Record<string, string> = {
  ApplicationResponse: 'constancia de recepción (CDR)',
  CreditNote: 'nota de crédito',
  DebitNote: 'nota de débito',
  SummaryDocuments: 'resumen diario',
  VoidedDocuments: 'comunicación de baja',
}

/** Decodifica los bytes de un XML respetando su BOM o la codificación declarada en el prólogo. */
export function decodeXml(bytes: Uint8Array): string {
  const header = new TextDecoder('latin1').decode(bytes.subarray(0, 200))
  const declared = /encoding=["']([\w-]+)["']/i.exec(header)?.[1]
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  const encoding = hasBom ? 'utf-8' : (declared ?? 'utf-8')
  let decoder: TextDecoder
  try {
    decoder = new TextDecoder(encoding)
  } catch {
    decoder = new TextDecoder('utf-8')
  }
  return decoder.decode(bytes).replace(/^﻿/, '')
}

function fail(problem: Problem): ParseResult {
  return { ok: false, problem }
}

/** Ruta vigente (PartyIdentification/ID) con fallback a la legada (PartyTaxScheme/CompanyID). */
function rucOf(inv: Record<string, unknown>, role: string): string | undefined {
  return text(path(inv, role, 'Party', 'PartyIdentification', 'ID')) ?? text(path(inv, role, 'Party', 'PartyTaxScheme', 'CompanyID'))
}

function nameOf(inv: Record<string, unknown>, role: string): string | undefined {
  return (
    text(path(inv, role, 'Party', 'PartyLegalEntity', 'RegistrationName')) ??
    text(path(inv, role, 'Party', 'PartyTaxScheme', 'RegistrationName'))
  )
}

export function parseUblInvoice(rawXml: string): ParseResult {
  const xml = rawXml.replace(/^﻿/, '')
  if (!xml.trimStart().startsWith('<') || XMLValidator.validate(xml) !== true) {
    return fail(createProblem('UNREADABLE_XML'))
  }

  let document: Record<string, unknown>
  try {
    document = parser.parse(xml) as Record<string, unknown>
  } catch {
    return fail(createProblem('UNREADABLE_XML'))
  }

  const rootName = Object.keys(document).find((k) => k !== '?xml')
  if (rootName !== 'Invoice') {
    const kind = (rootName && ROOT_KINDS[rootName]) ?? rootName ?? 'desconocido'
    return fail(createProblem('XML_NOT_AN_INVOICE', { data: { kind } }))
  }
  const inv = document.Invoice as Record<string, unknown>

  const required = (name: string, value: string | undefined): string | ParseResult =>
    value && value.length > 0 ? value : fail(createProblem('XML_MISSING_REQUIRED_FIELD', { data: { field: name } }))

  const seriesNumber = required('serie y número', text(inv.ID))
  if (typeof seriesNumber !== 'string') return seriesNumber
  const issueDate = required('fecha de emisión', text(inv.IssueDate))
  if (typeof issueDate !== 'string') return issueDate
  const documentType = required('tipo de comprobante', text(inv.InvoiceTypeCode))
  if (typeof documentType !== 'string') return documentType
  const currency = required('moneda', text(inv.DocumentCurrencyCode))
  if (typeof currency !== 'string') return currency
  const issuerRuc = required('RUC del emisor', rucOf(inv, 'AccountingSupplierParty'))
  if (typeof issuerRuc !== 'string') return issuerRuc
  const recipientRuc = required('RUC del receptor', rucOf(inv, 'AccountingCustomerParty'))
  if (typeof recipientRuc !== 'string') return recipientRuc
  const rawTotal = required('total', text(path(inv, 'LegalMonetaryTotal', 'PayableAmount')))
  if (typeof rawTotal !== 'string') return rawTotal
  const total = normalizeAmount(rawTotal)
  if (total === null) return fail(createProblem('XML_MISSING_REQUIRED_FIELD', { data: { field: 'total' } }))
  if (!isIsoDate(issueDate)) {
    return fail(createProblem('XML_MISSING_REQUIRED_FIELD', { data: { field: 'fecha de emisión' } }))
  }

  let paymentTerms: PaymentTerms | null = null
  let netPendingAmount: string | null = null
  const installments: Installment[] = []
  let detraction: ParsedInvoice['detraction'] = null

  for (const term of asList(inv.PaymentTerms as Node | Node[])) {
    const id = text(path(term, 'ID'))
    const means = text(path(term, 'PaymentMeansID')) ?? ''
    const amount = normalizeAmount(text(path(term, 'Amount')) ?? '')
    if (id === 'FormaPago') {
      if (means === 'Contado') paymentTerms = 'CASH'
      else if (means === 'Credito') {
        paymentTerms = 'CREDIT'
        netPendingAmount = amount
      } else if (/^Cuota\d+$/i.test(means)) {
        const dueDate = text(path(term, 'PaymentDueDate')) ?? ''
        if (amount !== null && isIsoDate(dueDate)) installments.push({ id: means, amount, dueDate })
      }
    } else if (id === 'Detraccion') {
      const percent = Number(text(path(term, 'PaymentPercent')) ?? Number.NaN)
      if (amount !== null && Number.isFinite(percent)) detraction = { percent, amount }
    }
  }

  const invoice: ParsedInvoice = {
    documentType,
    seriesNumber,
    issueDate,
    currency,
    issuerRuc,
    issuerName: nameOf(inv, 'AccountingSupplierParty') ?? '',
    recipientRuc,
    recipientName: nameOf(inv, 'AccountingCustomerParty') ?? null,
    total,
    paymentTerms,
    netPendingAmount,
    installments,
    detraction,
    signed: path(inv, 'UBLExtensions', 'UBLExtension', 'ExtensionContent', 'Signature') !== undefined,
  }

  const validated = parsedInvoiceSchema.safeParse(invoice)
  return validated.success ? { ok: true, invoice: validated.data } : fail(createProblem('UNREADABLE_XML'))
}
```

`packages/shared/src/invoice/index.ts` (las reglas se agregan en la Tarea 6):
```ts
export {
  DEFAULT_TEST_XML,
  buildCdrXml,
  buildInvoiceXml,
  type TestInstallment,
  type TestXmlOptions,
} from './build-test-xml.js'
export { DOCUMENT_TYPE, DOCUMENT_TYPE_NAMES, type DocumentType, PAYMENT_TERMS, type PaymentTerms } from './codes.js'
export { type Installment, installmentSchema, type ParsedInvoice, parsedInvoiceSchema } from './parsed-invoice.js'
export { decodeXml, type ParseResult, parseUblInvoice } from './ubl-parser.js'
```

Agregar a `packages/shared/src/index.ts`:
```ts
export * from './invoice/index.js'
```

- [ ] **Step 6: Correr tests y verificación completa**

Run: `pnpm --filter @anticipate/shared test && pnpm typecheck && pnpm lint && pnpm build`
Expected: todos PASS. Si el test "lee el fixture estático" falla, regenerar el fixture con el comando del paso 2 (la fábrica cambió después de generarlo).

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src packages/shared/test
git commit -m "feat(shared): lector de factura electrónica UBL 2.1 con fábrica de XML de prueba"
```

---

### Task 6: Dominio `invoice` · reglas de validación parametrizadas

**Files:**
- Create: `packages/shared/src/invoice/rules.ts`
- Test: `packages/shared/src/invoice/rules.test.ts`
- Modify: `packages/shared/src/invoice/index.ts`

**Interfaces:**
- Consumes: `ParsedInvoice`, `parseUblInvoice`, `buildInvoiceXml` (Tarea 5); `Amount`, `sumAmounts`, `percentOf`, `compareAmounts`, `normalizeAmount`, `toCents` (Tarea 4); `daysBetween` (Tarea 4); `createProblem` (Tarea 2).
- Produces: `ValidationContext`, `InvoiceRule`, `INVOICE_RULES`, `validateInvoices(invoices, ctx): ValidationResult`, `validateRequestedAmount(amount, result): Problem | null`. La landing los corre en el navegador y la API en el servidor con el mismo contexto (D24).

**Diseño.** Cada regla es una función pura `(invoice, context) => Problem[]`. El contexto trae todo lo que varía por pagador o por configuración; ninguna regla contiene un valor de negocio. `supplierRuc` es opcional porque en la landing las facturas se leen antes de que el proveedor confirme su RUC (D22): si no viene, la regla del emisor se omite y la del conjunto exige que todas las facturas compartan emisor.

- [ ] **Step 1: Escribir los tests que fallan**

`packages/shared/src/invoice/rules.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { buildInvoiceXml, type TestXmlOptions } from './build-test-xml.js'
import { type ValidationContext, validateInvoices, validateRequestedAmount } from './rules.js'
import { parseUblInvoice } from './ubl-parser.js'

function invoice(options: TestXmlOptions = {}) {
  const r = parseUblInvoice(buildInvoiceXml(options))
  if (!r.ok) throw new Error(r.problem.code)
  return r.invoice
}

const ctx: ValidationContext = {
  payerRuc: '20131312955',
  payerName: 'SEA',
  supplierRuc: '20100070970',
  advancePercent: 80,
  minTermDays: 15,
  maxInvoices: 10,
  allowedCurrencies: ['PEN', 'USD'],
  today: '2026-09-23',
}

const codes = (r: ReturnType<typeof validateInvoices>) => r.problems.map((p) => p.code)

describe('validateInvoices · caso válido', () => {
  it('acepta una factura al crédito al pagador, del proveedor, con cuota futura', () => {
    const r = validateInvoices([invoice()], ctx)
    expect(r.problems).toEqual([])
    expect(r.validInvoices).toHaveLength(1)
    expect(r.currency).toBe('PEN')
    expect(r.totalNetPending).toBe('10620.00')
    expect(r.maxAmount).toBe('8496.00')
  })

  it('suma el neto pendiente de varias facturas y calcula el máximo con el porcentaje del contexto', () => {
    const r = validateInvoices(
      [invoice(), invoice({ seriesNumber: 'F001-124', netPendingAmount: '1000.00' })],
      { ...ctx, advancePercent: 50 },
    )
    expect(r.totalNetPending).toBe('11620.00')
    expect(r.maxAmount).toBe('5810.00')
  })
})

describe('validateInvoices · reglas por factura', () => {
  it('rechaza una boleta', () => {
    const r = validateInvoices([invoice({ documentType: '03' })], ctx)
    expect(codes(r)).toEqual(['DOCUMENT_TYPE_NOT_ALLOWED'])
    expect(r.problems[0]?.invoice).toBe('F001-123')
    expect(r.problems[0]?.message).toContain('boleta de venta')
  })

  it('rechaza una factura emitida a otro receptor', () => {
    const r = validateInvoices([invoice({ recipientRuc: '20100070970' })], ctx)
    expect(codes(r)).toEqual(['RECIPIENT_IS_NOT_PAYER'])
    expect(r.problems[0]?.message).toContain('SEA')
  })

  it('rechaza una factura de otro emisor cuando el contexto trae el RUC del proveedor', () => {
    const r = validateInvoices([invoice({ issuerRuc: '10467286736' })], ctx)
    expect(codes(r)).toEqual(['ISSUER_IS_NOT_SUPPLIER'])
  })

  it('no aplica la regla del emisor si el contexto no trae el RUC del proveedor', () => {
    const { supplierRuc: _omitted, ...withoutSupplier } = ctx
    const r = validateInvoices([invoice({ issuerRuc: '10467286736' })], withoutSupplier)
    expect(codes(r)).toEqual([])
  })

  it('rechaza una factura al contado', () => {
    const r = validateInvoices([invoice({ paymentTerms: 'Contado', netPendingAmount: null, installments: [] })], ctx)
    expect(codes(r)).toEqual(['CASH_INVOICE'])
  })

  it('rechaza una factura sin forma de pago o sin neto pendiente', () => {
    expect(codes(validateInvoices([invoice({ paymentTerms: null, installments: [] })], ctx))).toEqual(['NO_PENDING_AMOUNT'])
    expect(codes(validateInvoices([invoice({ netPendingAmount: '0.00' })], ctx))).toEqual(['NO_PENDING_AMOUNT'])
  })

  it('rechaza una moneda que el pagador no acepta', () => {
    const r = validateInvoices([invoice({ currency: 'EUR' })], { ...ctx, allowedCurrencies: ['PEN'] })
    expect(codes(r)).toEqual(['CURRENCY_NOT_ALLOWED'])
  })

  it('señala la cuota vencida aunque otra sea futura', () => {
    const r = validateInvoices(
      [
        invoice({
          installments: [
            { id: 'Cuota001', amount: '5000.00', dueDate: '2026-09-01' },
            { id: 'Cuota002', amount: '5620.00', dueDate: '2026-12-01' },
          ],
        }),
      ],
      ctx,
    )
    expect(codes(r)).toEqual(['INSTALLMENT_OVERDUE'])
    expect(r.problems[0]?.message).toContain('Cuota001')
  })

  it('exige el plazo mínimo del contexto', () => {
    const r = validateInvoices([invoice({ installments: [{ id: 'Cuota001', amount: '10620.00', dueDate: '2026-10-01' }] })], ctx)
    expect(codes(r)).toEqual(['INSUFFICIENT_TERM'])
    const ok = validateInvoices([invoice({ installments: [{ id: 'Cuota001', amount: '10620.00', dueDate: '2026-10-08' }] })], ctx)
    expect(codes(ok)).toEqual([])
  })

  it('una factura al crédito sin cuotas es un dato obligatorio ausente', () => {
    expect(codes(validateInvoices([invoice({ installments: [] })], ctx))).toEqual(['XML_MISSING_REQUIRED_FIELD'])
  })
})

describe('validateInvoices · reglas del conjunto', () => {
  it('rechaza una solicitud sin facturas', () => {
    expect(codes(validateInvoices([], ctx))).toEqual(['NO_INVOICES'])
  })

  it('rechaza más facturas que el máximo del contexto', () => {
    const three = ['F001-1', 'F001-2', 'F001-3'].map((seriesNumber) => invoice({ seriesNumber }))
    expect(codes(validateInvoices(three, { ...ctx, maxInvoices: 2 }))).toEqual(['TOO_MANY_INVOICES'])
  })

  it('rechaza la misma factura repetida, ignorando mayúsculas y espacios', () => {
    const r = validateInvoices([invoice(), invoice({ seriesNumber: ' f001-123 ' })], ctx)
    expect(codes(r)).toEqual(['DUPLICATE_INVOICE'])
  })

  it('rechaza emisores distintos cuando no hay RUC del proveedor en el contexto', () => {
    const { supplierRuc: _omitted, ...withoutSupplier } = ctx
    const r = validateInvoices([invoice(), invoice({ seriesNumber: 'F001-9', issuerRuc: '10467286736' })], withoutSupplier)
    expect(codes(r)).toEqual(['MIXED_ISSUERS'])
  })

  it('rechaza monedas distintas y no calcula máximo', () => {
    const r = validateInvoices([invoice(), invoice({ seriesNumber: 'F001-9', currency: 'USD' })], ctx)
    expect(codes(r)).toEqual(['MIXED_CURRENCIES'])
    expect(r.currency).toBeNull()
    expect(r.maxAmount).toBe('0.00')
  })

  it('las facturas con problemas no cuentan para el máximo', () => {
    const r = validateInvoices([invoice(), invoice({ seriesNumber: 'F001-9', paymentTerms: 'Contado', installments: [] })], ctx)
    expect(r.validInvoices).toHaveLength(1)
    expect(r.maxAmount).toBe('8496.00')
  })
})

describe('validateRequestedAmount', () => {
  const result = validateInvoices([invoice()], ctx)

  it('acepta un monto hasta el máximo', () => {
    expect(validateRequestedAmount('8496.00', result)).toBeNull()
    expect(validateRequestedAmount('100.00', result)).toBeNull()
  })

  it('rechaza un monto mayor al máximo con el máximo y la moneda en el mensaje', () => {
    const p = validateRequestedAmount('8496.01', result)
    expect(p?.code).toBe('AMOUNT_EXCEEDS_MAXIMUM')
    expect(p?.message).toBe('El monto solicitado supera el máximo de 8496.00 PEN.')
  })

  it('rechaza montos inválidos', () => {
    expect(validateRequestedAmount('abc', result)?.code).toBe('INVALID_AMOUNT')
    expect(validateRequestedAmount('0.00', result)?.code).toBe('INVALID_AMOUNT')
  })
})
```

- [ ] **Step 2: Correr y verificar que fallan**

Run: `pnpm --filter @anticipate/shared test -- rules`
Expected: FAIL, "Cannot find module './rules.js'".

- [ ] **Step 3: Implementar**

`packages/shared/src/invoice/rules.ts`:
```ts
import { type IsoDate, daysBetween } from '../dates/index.js'
import { type Problem, createProblem } from '../errors/index.js'
import { type Amount, compareAmounts, normalizeAmount, percentOf, sumAmounts, toCents } from '../money/index.js'
import { DOCUMENT_TYPE, DOCUMENT_TYPE_NAMES } from './codes.js'
import type { ParsedInvoice } from './parsed-invoice.js'

/** Todo lo que varía por pagador o por configuración. Ninguna regla guarda valores propios. */
export type ValidationContext = {
  payerRuc: string
  payerName: string
  /** Opcional: en la landing las facturas se leen antes de conocer el RUC del proveedor. */
  supplierRuc?: string
  /** 0 a 100. */
  advancePercent: number
  minTermDays: number
  maxInvoices: number
  allowedCurrencies: readonly string[]
  today: IsoDate
}

export type InvoiceRule = (invoice: ParsedInvoice, ctx: ValidationContext) => Problem[]

const forInvoice = (inv: ParsedInvoice, problem: Problem): Problem => ({ ...problem, invoice: inv.seriesNumber })

export const documentTypeRule: InvoiceRule = (inv) =>
  inv.documentType === DOCUMENT_TYPE.INVOICE
    ? []
    : [
        forInvoice(
          inv,
          createProblem('DOCUMENT_TYPE_NOT_ALLOWED', {
            data: { kind: DOCUMENT_TYPE_NAMES[inv.documentType] ?? inv.documentType },
          }),
        ),
      ]

export const recipientIsPayerRule: InvoiceRule = (inv, ctx) =>
  inv.recipientRuc === ctx.payerRuc
    ? []
    : [forInvoice(inv, createProblem('RECIPIENT_IS_NOT_PAYER', { data: { payer: ctx.payerName } }))]

export const issuerIsSupplierRule: InvoiceRule = (inv, ctx) =>
  ctx.supplierRuc === undefined || inv.issuerRuc === ctx.supplierRuc
    ? []
    : [forInvoice(inv, createProblem('ISSUER_IS_NOT_SUPPLIER', { data: { issuer: inv.issuerRuc } }))]

export const creditWithPendingAmountRule: InvoiceRule = (inv) => {
  if (inv.paymentTerms === 'CASH') return [forInvoice(inv, createProblem('CASH_INVOICE'))]
  if (inv.paymentTerms !== 'CREDIT' || inv.netPendingAmount === null || toCents(inv.netPendingAmount) === 0n) {
    return [forInvoice(inv, createProblem('NO_PENDING_AMOUNT'))]
  }
  return []
}

export const currencyAllowedRule: InvoiceRule = (inv, ctx) =>
  ctx.allowedCurrencies.includes(inv.currency)
    ? []
    : [forInvoice(inv, createProblem('CURRENCY_NOT_ALLOWED', { data: { currency: inv.currency } }))]

export const installmentsDueInFutureRule: InvoiceRule = (inv, ctx) => {
  if (inv.paymentTerms !== 'CREDIT') return []
  if (inv.installments.length === 0) {
    return [forInvoice(inv, createProblem('XML_MISSING_REQUIRED_FIELD', { data: { field: 'fechas de vencimiento (cuotas)' } }))]
  }
  const problems: Problem[] = []
  for (const installment of inv.installments) {
    const days = daysBetween(ctx.today, installment.dueDate)
    if (days < 0) {
      problems.push(
        forInvoice(inv, createProblem('INSTALLMENT_OVERDUE', { data: { installment: installment.id, date: installment.dueDate } })),
      )
    } else if (days < ctx.minTermDays) {
      problems.push(
        forInvoice(inv, createProblem('INSUFFICIENT_TERM', { data: { installment: installment.id, days: ctx.minTermDays } })),
      )
    }
  }
  return problems
}

/** Orden de evaluación. Agregar una regla = agregar una función aquí y su test. */
export const INVOICE_RULES: readonly InvoiceRule[] = [
  documentTypeRule,
  recipientIsPayerRule,
  issuerIsSupplierRule,
  creditWithPendingAmountRule,
  currencyAllowedRule,
  installmentsDueInFutureRule,
]

export type ValidationResult = {
  problems: Problem[]
  validInvoices: ParsedInvoice[]
  /** Moneda común de las facturas válidas, o null si no hay o difieren. */
  currency: string | null
  totalNetPending: Amount
  /** Neto pendiente total × porcentaje de adelanto. "0.00" si no se puede calcular. */
  maxAmount: Amount
}

const invoiceKey = (inv: ParsedInvoice) => inv.seriesNumber.trim().toUpperCase()

export function validateInvoices(invoices: readonly ParsedInvoice[], ctx: ValidationContext): ValidationResult {
  const problems: Problem[] = []
  const empty: ValidationResult = { problems, validInvoices: [], currency: null, totalNetPending: '0.00', maxAmount: '0.00' }

  if (invoices.length === 0) {
    problems.push(createProblem('NO_INVOICES'))
    return empty
  }
  if (invoices.length > ctx.maxInvoices) {
    problems.push(createProblem('TOO_MANY_INVOICES', { data: { max: ctx.maxInvoices } }))
    return empty
  }

  const seen = new Set<string>()
  const candidates: ParsedInvoice[] = []
  for (const inv of invoices) {
    const key = invoiceKey(inv)
    if (seen.has(key)) {
      problems.push(createProblem('DUPLICATE_INVOICE', { invoice: inv.seriesNumber, data: { invoice: inv.seriesNumber } }))
      continue
    }
    seen.add(key)
    candidates.push(inv)
  }

  const validInvoices = candidates.filter((inv) => {
    const own = INVOICE_RULES.flatMap((rule) => rule(inv, ctx))
    problems.push(...own)
    return own.length === 0
  })
  if (validInvoices.length === 0) return { ...empty, problems }

  const issuers = new Set(validInvoices.map((inv) => inv.issuerRuc))
  if (issuers.size > 1) problems.push(createProblem('MIXED_ISSUERS'))

  const currencies = new Set(validInvoices.map((inv) => inv.currency))
  if (currencies.size > 1) {
    problems.push(createProblem('MIXED_CURRENCIES'))
    return { ...empty, problems, validInvoices }
  }

  const totalNetPending = sumAmounts(...validInvoices.map((inv) => inv.netPendingAmount ?? '0.00'))
  return {
    problems,
    validInvoices,
    currency: validInvoices[0]?.currency ?? null,
    totalNetPending,
    maxAmount: percentOf(totalNetPending, ctx.advancePercent),
  }
}

export function validateRequestedAmount(amount: string, result: ValidationResult): Problem | null {
  const normalized = normalizeAmount(amount)
  if (normalized === null || toCents(normalized) === 0n) return createProblem('INVALID_AMOUNT', { field: 'requestedAmount' })
  if (compareAmounts(normalized, result.maxAmount) > 0) {
    return createProblem('AMOUNT_EXCEEDS_MAXIMUM', {
      field: 'requestedAmount',
      data: { max: result.maxAmount, currency: result.currency ?? '' },
    })
  }
  return null
}
```

Agregar a `packages/shared/src/invoice/index.ts`:
```ts
export {
  INVOICE_RULES,
  type InvoiceRule,
  creditWithPendingAmountRule,
  currencyAllowedRule,
  documentTypeRule,
  installmentsDueInFutureRule,
  issuerIsSupplierRule,
  recipientIsPayerRule,
  type ValidationContext,
  type ValidationResult,
  validateInvoices,
  validateRequestedAmount,
} from './rules.js'
```

- [ ] **Step 4: Correr tests y verificación completa**

Run: `pnpm --filter @anticipate/shared test && pnpm typecheck && pnpm lint`
Expected: todos PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src
git commit -m "feat(shared): reglas de factura parametrizadas por contexto del pagador"
```

---

### Task 7: Dominios `user` y `advance-request` · roles, estados, motivos y transiciones como datos

**Files:**
- Create: `packages/shared/src/user/roles.ts`, `packages/shared/src/user/index.ts`
- Create: `packages/shared/src/advance-request/statuses.ts`, `packages/shared/src/advance-request/close-reasons.ts`, `packages/shared/src/advance-request/transitions.ts`, `packages/shared/src/advance-request/index.ts`
- Test: `packages/shared/src/user/roles.test.ts`, `packages/shared/src/advance-request/transitions.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces: `ROLES`, `Role`, `hasRoleAtLeast(role, minimum)`, `roleSchema`, `ROLE_LABELS`; `ADVANCE_REQUEST_STATUSES`, `AdvanceRequestStatus`, `INITIAL_STATUS`, `TERMINAL_STATUSES`, `isTerminalStatus`, `STATUS_LABELS`, `advanceRequestStatusSchema`; `CLOSE_REASONS`, `CloseReason`, `CLOSE_REASONS_BY_STATUS`, `CLOSE_REASON_LABELS`, `closeReasonSchema`; `GUARDS`, `Guard`, `Facts`, `Transition`, `TRANSITIONS`, `transitionsFrom(from, role)`, `availableTransitions(from, role, facts)`, `evaluateStatusChange(change): StatusChangeResult`, `statusChangeSchema`. La API calcula los `Facts` con Prisma (por ejemplo `documentsValid`), devuelve `availableTransitions` como `allowedActions` en cada respuesta de solicitud y vuelve a evaluar en el PATCH; el admin pinta solo esos botones.

- [ ] **Step 1: Escribir los tests que fallan**

`packages/shared/src/user/roles.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { hasRoleAtLeast } from './roles.js'

describe('hasRoleAtLeast', () => {
  it('ADMIN alcanza todo; AGENT solo AGENT', () => {
    expect(hasRoleAtLeast('ADMIN', 'ADMIN')).toBe(true)
    expect(hasRoleAtLeast('ADMIN', 'AGENT')).toBe(true)
    expect(hasRoleAtLeast('AGENT', 'AGENT')).toBe(true)
    expect(hasRoleAtLeast('AGENT', 'ADMIN')).toBe(false)
  })
})
```

`packages/shared/src/advance-request/transitions.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { CLOSE_REASONS_BY_STATUS } from './close-reasons.js'
import { ADVANCE_REQUEST_STATUSES, INITIAL_STATUS, TERMINAL_STATUSES, isTerminalStatus } from './statuses.js'
import {
  TRANSITIONS,
  availableTransitions,
  evaluateStatusChange,
  statusChangeSchema,
  transitionsFrom,
} from './transitions.js'

const exits = (status: string) => TRANSITIONS.filter((t) => t.from === status).map((t) => t.to)

describe('estructura de la máquina de estados', () => {
  it('no hay transiciones duplicadas', () => {
    const keys = TRANSITIONS.map((t) => `${t.from}->${t.to}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('los estados terminales no tienen salida', () => {
    for (const s of TERMINAL_STATUSES) expect(exits(s), s).toEqual([])
  })

  it('todo estado es alcanzable desde el inicial', () => {
    const seen = new Set<string>([INITIAL_STATUS])
    const queue = [INITIAL_STATUS as string]
    while (queue.length > 0) {
      const current = queue.shift() as string
      for (const next of exits(current)) if (!seen.has(next)) { seen.add(next); queue.push(next) }
    }
    for (const s of ADVANCE_REQUEST_STATUSES) expect(seen.has(s), `${s} no es alcanzable`).toBe(true)
  })

  it('todo estado no terminal tiene camino a un estado terminal', () => {
    const reachesTerminal = (from: string, seen = new Set<string>()): boolean => {
      if (isTerminalStatus(from as never)) return true
      if (seen.has(from)) return false
      seen.add(from)
      return exits(from).some((next) => reachesTerminal(next, seen))
    }
    for (const s of ADVANCE_REQUEST_STATUSES) expect(reachesTerminal(s), `${s} no llega a un estado terminal`).toBe(true)
  })

  it('toda transición hacia REJECTED o WITHDRAWN exige motivo, y ninguna otra', () => {
    for (const t of TRANSITIONS) {
      const isClosure = t.to === 'REJECTED' || t.to === 'WITHDRAWN'
      expect(t.requiresReason === true, `${t.from}->${t.to}`).toBe(isClosure)
    }
  })

  it('cada estado de cierre tiene motivos definidos', () => {
    expect(CLOSE_REASONS_BY_STATUS.REJECTED.length).toBeGreaterThan(0)
    expect(CLOSE_REASONS_BY_STATUS.WITHDRAWN.length).toBeGreaterThan(0)
  })
})

describe('transitionsFrom', () => {
  it('filtra por rol mínimo', () => {
    expect(transitionsFrom('APPROVED', 'ADMIN').map((t) => t.to)).toEqual(['DISBURSED', 'WITHDRAWN'])
    expect(transitionsFrom('APPROVED', 'AGENT').map((t) => t.to)).toEqual(['WITHDRAWN'])
  })

  it('devuelve vacío para estados terminales', () => {
    expect(transitionsFrom('DISBURSED', 'ADMIN')).toEqual([])
  })
})

describe('availableTransitions', () => {
  it('oculta las transiciones cuya guarda no se cumple', () => {
    expect(availableTransitions('DOCUMENTS_PENDING', 'AGENT', {}).map((t) => t.to)).toEqual(['REJECTED', 'WITHDRAWN'])
    expect(
      availableTransitions('DOCUMENTS_PENDING', 'AGENT', { documentsValid: true }).map((t) => t.to),
    ).toEqual(['UNDER_REVIEW', 'REJECTED', 'WITHDRAWN'])
  })
})

describe('evaluateStatusChange', () => {
  it('acepta una transición simple sin guarda', () => {
    const r = evaluateStatusChange({ from: 'NEW', to: 'CONTACTED', role: 'AGENT' })
    expect(r).toEqual({ ok: true, guard: null, requiresReason: false })
  })

  it('devuelve la guarda que la API debe comprobar', () => {
    const r = evaluateStatusChange({ from: 'DOCUMENTS_PENDING', to: 'UNDER_REVIEW', role: 'AGENT' })
    expect(r).toEqual({ ok: true, guard: 'documentsValid', requiresReason: false })
  })

  it('rechaza una transición que no existe', () => {
    const r = evaluateStatusChange({ from: 'NEW', to: 'DISBURSED', role: 'ADMIN' })
    expect(r).toEqual({ ok: false, reason: 'TRANSITION_NOT_ALLOWED' })
  })

  it('rechaza por rol insuficiente', () => {
    const r = evaluateStatusChange({ from: 'APPROVED', to: 'DISBURSED', role: 'AGENT' })
    expect(r).toEqual({ ok: false, reason: 'INSUFFICIENT_ROLE' })
  })

  it('exige motivo en los cierres y que sea válido para ese estado', () => {
    expect(evaluateStatusChange({ from: 'NEW', to: 'WITHDRAWN', role: 'AGENT' })).toEqual({
      ok: false,
      reason: 'REASON_REQUIRED',
    })
    expect(
      evaluateStatusChange({ from: 'NEW', to: 'WITHDRAWN', role: 'AGENT', closeReason: 'INVALID_DOCUMENTS' }),
    ).toEqual({ ok: false, reason: 'REASON_NOT_VALID' })
    expect(
      evaluateStatusChange({ from: 'NEW', to: 'WITHDRAWN', role: 'AGENT', closeReason: 'SPAM_OR_INVALID' }),
    ).toEqual({ ok: true, guard: null, requiresReason: true })
  })
})

describe('statusChangeSchema (cuerpo del PATCH de la API)', () => {
  it('acepta destino, versión y motivo opcional', () => {
    expect(statusChangeSchema.safeParse({ to: 'CONTACTED', version: 3 }).success).toBe(true)
    expect(
      statusChangeSchema.safeParse({ to: 'WITHDRAWN', version: 3, closeReason: 'NO_RESPONSE', closeReasonDetail: 'Tres llamadas' }).success,
    ).toBe(true)
  })

  it('rechaza estados desconocidos y versiones no enteras', () => {
    expect(statusChangeSchema.safeParse({ to: 'CLOSED', version: 1 }).success).toBe(false)
    expect(statusChangeSchema.safeParse({ to: 'CONTACTED', version: 1.5 }).success).toBe(false)
  })
})
```

- [ ] **Step 2: Correr y verificar que fallan**

Run: `pnpm --filter @anticipate/shared test -- user advance-request`
Expected: FAIL por módulos inexistentes.

- [ ] **Step 3: Implementar `user`**

`packages/shared/src/user/roles.ts`:
```ts
import { z } from 'zod'

/** Roles del admin, de menor a mayor. Agregar uno = agregarlo aquí en su posición. */
export const ROLES = ['AGENT', 'ADMIN'] as const
export type Role = (typeof ROLES)[number]
export const roleSchema = z.enum(ROLES)

export const ROLE_LABELS: Record<Role, string> = { AGENT: 'Gestor', ADMIN: 'Administrador' }

export function hasRoleAtLeast(role: Role, minimum: Role): boolean {
  return ROLES.indexOf(role) >= ROLES.indexOf(minimum)
}
```

`packages/shared/src/user/index.ts`:
```ts
export { ROLE_LABELS, ROLES, type Role, hasRoleAtLeast, roleSchema } from './roles.js'
```

- [ ] **Step 4: Implementar `advance-request` · estados y motivos**

`packages/shared/src/advance-request/statuses.ts`:
```ts
import { z } from 'zod'

export const ADVANCE_REQUEST_STATUSES = [
  'NEW',
  'NO_ANSWER',
  'CONTACTED',
  'DOCUMENTS_PENDING',
  'UNDER_REVIEW',
  'QUOTE_SENT',
  'APPROVED',
  'DISBURSED',
  'REJECTED',
  'WITHDRAWN',
] as const
export type AdvanceRequestStatus = (typeof ADVANCE_REQUEST_STATUSES)[number]
export const advanceRequestStatusSchema = z.enum(ADVANCE_REQUEST_STATUSES)

export const INITIAL_STATUS = 'NEW' satisfies AdvanceRequestStatus

export const TERMINAL_STATUSES = ['DISBURSED', 'REJECTED', 'WITHDRAWN'] as const satisfies readonly AdvanceRequestStatus[]
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number]

export function isTerminalStatus(status: AdvanceRequestStatus): status is TerminalStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(status)
}

/** Etiquetas en español para la interfaz. */
export const STATUS_LABELS: Record<AdvanceRequestStatus, string> = {
  NEW: 'Nueva',
  NO_ANSWER: 'No contesta',
  CONTACTED: 'Contactado',
  DOCUMENTS_PENDING: 'Documentos pendientes',
  UNDER_REVIEW: 'En evaluación',
  QUOTE_SENT: 'Proforma enviada',
  APPROVED: 'Aprobada',
  DISBURSED: 'Desembolsada',
  REJECTED: 'Rechazada',
  WITHDRAWN: 'Desistida',
}
```

`packages/shared/src/advance-request/close-reasons.ts`:
```ts
import { z } from 'zod'

export const CLOSE_REASONS = [
  'NO_RESPONSE',
  'SPAM_OR_INVALID',
  'SUPPLIER_WITHDREW',
  'INVALID_DOCUMENTS',
  'INVOICE_NOT_ELIGIBLE',
  'UNACCEPTABLE_RISK',
  'OTHER',
] as const
export type CloseReason = (typeof CLOSE_REASONS)[number]
export const closeReasonSchema = z.enum(CLOSE_REASONS)

export const CLOSE_REASON_LABELS: Record<CloseReason, string> = {
  NO_RESPONSE: 'El proveedor no respondió',
  SPAM_OR_INVALID: 'Solicitud de prueba, spam o inválida',
  SUPPLIER_WITHDREW: 'El proveedor decidió no continuar',
  INVALID_DOCUMENTS: 'Documentos incompletos o inválidos',
  INVOICE_NOT_ELIGIBLE: 'La factura no cumple los requisitos',
  UNACCEPTABLE_RISK: 'Riesgo no aceptable',
  OTHER: 'Otro motivo (ver detalle)',
}

/** Qué motivos tienen sentido para cada estado de cierre. */
export const CLOSE_REASONS_BY_STATUS = {
  REJECTED: ['INVALID_DOCUMENTS', 'INVOICE_NOT_ELIGIBLE', 'UNACCEPTABLE_RISK', 'SPAM_OR_INVALID', 'OTHER'],
  WITHDRAWN: ['NO_RESPONSE', 'SUPPLIER_WITHDREW', 'SPAM_OR_INVALID', 'OTHER'],
} as const satisfies Record<'REJECTED' | 'WITHDRAWN', readonly CloseReason[]>
```

- [ ] **Step 5: Implementar `advance-request` · transiciones**

`packages/shared/src/advance-request/transitions.ts`:
```ts
import { z } from 'zod'
import { type Role, hasRoleAtLeast } from '../user/index.js'
import { CLOSE_REASONS_BY_STATUS, type CloseReason, closeReasonSchema } from './close-reasons.js'
import { type AdvanceRequestStatus, advanceRequestStatusSchema } from './statuses.js'

/** Nombres de guardas. La API las implementa (necesitan base de datos); shared solo las nombra. */
export const GUARDS = ['documentsValid'] as const
export type Guard = (typeof GUARDS)[number]

export type Transition = {
  from: AdvanceRequestStatus
  to: AdvanceRequestStatus
  guard?: Guard
  minRole?: Role
  requiresReason?: true
}

/** Única fuente de verdad de la máquina de estados (STACK §9). El admin pinta botones con esto; la API lo hace cumplir. */
export const TRANSITIONS: readonly Transition[] = [
  { from: 'NEW', to: 'CONTACTED' },
  { from: 'NEW', to: 'NO_ANSWER' },
  { from: 'NEW', to: 'WITHDRAWN', requiresReason: true },
  { from: 'NO_ANSWER', to: 'CONTACTED' },
  { from: 'NO_ANSWER', to: 'WITHDRAWN', requiresReason: true },
  { from: 'CONTACTED', to: 'DOCUMENTS_PENDING' },
  { from: 'CONTACTED', to: 'WITHDRAWN', requiresReason: true },
  { from: 'DOCUMENTS_PENDING', to: 'UNDER_REVIEW', guard: 'documentsValid' },
  { from: 'DOCUMENTS_PENDING', to: 'REJECTED', requiresReason: true },
  { from: 'DOCUMENTS_PENDING', to: 'WITHDRAWN', requiresReason: true },
  { from: 'UNDER_REVIEW', to: 'QUOTE_SENT' },
  { from: 'UNDER_REVIEW', to: 'REJECTED', requiresReason: true },
  { from: 'QUOTE_SENT', to: 'APPROVED' },
  { from: 'QUOTE_SENT', to: 'WITHDRAWN', requiresReason: true },
  { from: 'APPROVED', to: 'DISBURSED', minRole: 'ADMIN' },
  { from: 'APPROVED', to: 'WITHDRAWN', requiresReason: true },
]

export function transitionsFrom(from: AdvanceRequestStatus, role: Role): Transition[] {
  return TRANSITIONS.filter((t) => t.from === from && hasRoleAtLeast(role, t.minRole ?? 'AGENT'))
}

/** Hechos que la API calcula con la base de datos para resolver las guardas. */
export type Facts = Partial<Record<Guard, boolean>>

/** Lo que el usuario puede hacer ahora mismo: filtra por rol y por guardas ya resueltas. La API lo devuelve como `allowedActions`. */
export function availableTransitions(from: AdvanceRequestStatus, role: Role, facts: Facts): Transition[] {
  return transitionsFrom(from, role).filter((t) => t.guard === undefined || facts[t.guard] === true)
}

export type StatusChange = {
  from: AdvanceRequestStatus
  to: AdvanceRequestStatus
  role: Role
  closeReason?: CloseReason
}

export type StatusChangeResult =
  | { ok: true; guard: Guard | null; requiresReason: boolean }
  | { ok: false; reason: 'TRANSITION_NOT_ALLOWED' | 'INSUFFICIENT_ROLE' | 'REASON_REQUIRED' | 'REASON_NOT_VALID' }

/** Evaluación pura. Si devuelve `guard`, la API debe comprobarla contra la base de datos antes de aplicar el cambio. */
export function evaluateStatusChange(change: StatusChange): StatusChangeResult {
  const t = TRANSITIONS.find((x) => x.from === change.from && x.to === change.to)
  if (!t) return { ok: false, reason: 'TRANSITION_NOT_ALLOWED' }
  if (!hasRoleAtLeast(change.role, t.minRole ?? 'AGENT')) return { ok: false, reason: 'INSUFFICIENT_ROLE' }
  const requiresReason = t.requiresReason === true
  if (requiresReason) {
    if (!change.closeReason) return { ok: false, reason: 'REASON_REQUIRED' }
    const allowed = CLOSE_REASONS_BY_STATUS[t.to as keyof typeof CLOSE_REASONS_BY_STATUS] as readonly CloseReason[]
    if (!allowed.includes(change.closeReason)) return { ok: false, reason: 'REASON_NOT_VALID' }
  }
  return { ok: true, guard: t.guard ?? null, requiresReason }
}

/** Cuerpo de `PATCH /admin/advance-requests/:id/status`. `version` sostiene el bloqueo optimista (D28). */
export const statusChangeSchema = z.object({
  to: advanceRequestStatusSchema,
  version: z.number().int().nonnegative(),
  closeReason: closeReasonSchema.optional(),
  closeReasonDetail: z.string().trim().max(500).optional(),
})
export type StatusChangeDto = z.infer<typeof statusChangeSchema>
```

`packages/shared/src/advance-request/index.ts` (formulario y código público se agregan en la Tarea 8):
```ts
export {
  CLOSE_REASON_LABELS,
  CLOSE_REASONS,
  CLOSE_REASONS_BY_STATUS,
  type CloseReason,
  closeReasonSchema,
} from './close-reasons.js'
export {
  ADVANCE_REQUEST_STATUSES,
  type AdvanceRequestStatus,
  advanceRequestStatusSchema,
  INITIAL_STATUS,
  isTerminalStatus,
  STATUS_LABELS,
  TERMINAL_STATUSES,
  type TerminalStatus,
} from './statuses.js'
export {
  availableTransitions,
  evaluateStatusChange,
  type Facts,
  GUARDS,
  type Guard,
  type StatusChange,
  type StatusChangeDto,
  type StatusChangeResult,
  statusChangeSchema,
  TRANSITIONS,
  type Transition,
  transitionsFrom,
} from './transitions.js'
```

Agregar a `packages/shared/src/index.ts`:
```ts
export * from './user/index.js'
export * from './advance-request/index.js'
```

- [ ] **Step 6: Correr tests y verificación completa**

Run: `pnpm --filter @anticipate/shared test && pnpm typecheck && pnpm lint`
Expected: todos PASS. En particular los tests estructurales: si alguien quita una flecha de cierre, "todo estado no terminal tiene camino a un estado terminal" falla en CI.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src
git commit -m "feat(shared): máquina de estados como datos con guardas, roles, motivos y test estructural"
```

---

### Task 8: Dominio `advance-request` · esquema del formulario y código público

**Files:**
- Create: `packages/shared/src/advance-request/form.ts`, `packages/shared/src/advance-request/public-code.ts`
- Test: `packages/shared/src/advance-request/form.test.ts`, `packages/shared/src/advance-request/public-code.test.ts`
- Modify: `packages/shared/src/advance-request/index.ts`

**Interfaces:**
- Consumes: `rucSchema`, `dniSchema` (Tarea 3); `amountSchema` (Tarea 4).
- Produces: `CONTACT_TIME_SLOTS`, `CONTACT_TIME_SLOT_LABELS`, `CAVALI_REGISTRATION`, `advanceRequestFormSchema`, `AdvanceRequestForm`; `formatPublicCode({ prefix, year, sequence })`, `parsePublicCode(text)`. La landing lo usa con `zodResolver`; la API como DTO del campo JSON del multipart (los archivos se validan aparte, STACK §8).

- [ ] **Step 1: Escribir los tests que fallan**

`packages/shared/src/advance-request/form.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { advanceRequestFormSchema } from './form.js'

const valid = {
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
}

describe('advanceRequestFormSchema', () => {
  it('acepta un formulario completo', () => {
    expect(advanceRequestFormSchema.safeParse(valid).success).toBe(true)
  })

  it('exige cargo cuando el contacto no es representante legal', () => {
    const r = advanceRequestFormSchema.safeParse({
      ...valid,
      contact: { ...valid.contact, isLegalRepresentative: false },
    })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['contact', 'jobTitle'])
  })

  it('acepta cargo cuando no es representante', () => {
    const r = advanceRequestFormSchema.safeParse({
      ...valid,
      contact: { ...valid.contact, isLegalRepresentative: false, jobTitle: 'Contadora' },
    })
    expect(r.success).toBe(true)
  })

  it('exige ambos consentimientos en true', () => {
    const r = advanceRequestFormSchema.safeParse({
      ...valid,
      consents: { ...valid.consents, personalData: false },
    })
    expect(r.success).toBe(false)
  })

  it('valida celular peruano de 9 dígitos que empieza en 9', () => {
    for (const mobile of ['98765432', '187654321', '9876 54321']) {
      const r = advanceRequestFormSchema.safeParse({ ...valid, contact: { ...valid.contact, mobile } })
      expect(r.success, mobile).toBe(false)
    }
  })

  it('normaliza correo a minúsculas y recorta espacios', () => {
    const r = advanceRequestFormSchema.parse({ ...valid, contact: { ...valid.contact, email: '  Ana@Proveedor.PE ' } })
    expect(r.contact.email).toBe('ana@proveedor.pe')
  })

  it('source es opcional y sus utm se limitan a claves utm_*', () => {
    const { source: _omitted, ...withoutSource } = valid
    expect(advanceRequestFormSchema.safeParse(withoutSource).success).toBe(true)
    const r = advanceRequestFormSchema.safeParse({ ...valid, source: { utm: { password: 'x' } } })
    expect(r.success).toBe(false)
  })
})
```

`packages/shared/src/advance-request/public-code.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { formatPublicCode, parsePublicCode } from './public-code.js'

describe('código público de solicitud', () => {
  it('formatea con prefijo, año y secuencia de seis dígitos', () => {
    expect(formatPublicCode({ prefix: 'ANT', year: 2026, sequence: 123 })).toBe('ANT-2026-000123')
    expect(formatPublicCode({ prefix: 'ANT', year: 2026, sequence: 1_234_567 })).toBe('ANT-2026-1234567')
  })

  it('parsea y rechaza formatos ajenos', () => {
    expect(parsePublicCode('ANT-2026-000123')).toEqual({ prefix: 'ANT', year: 2026, sequence: 123 })
    expect(parsePublicCode('ant-2026-000123')).toEqual({ prefix: 'ANT', year: 2026, sequence: 123 })
    expect(parsePublicCode('2026-000123')).toBeNull()
    expect(parsePublicCode('ANT-26-1')).toBeNull()
  })
})
```

- [ ] **Step 2: Correr y verificar que fallan**

Run: `pnpm --filter @anticipate/shared test -- form public-code`
Expected: FAIL por módulos inexistentes.

- [ ] **Step 3: Implementar**

`packages/shared/src/advance-request/form.ts`:
```ts
import { z } from 'zod'
import { dniSchema, rucSchema } from '../identity/index.js'
import { amountSchema } from '../money/index.js'

export const CONTACT_TIME_SLOTS = ['MORNING', 'AFTERNOON', 'ANY'] as const
export const CONTACT_TIME_SLOT_LABELS: Record<(typeof CONTACT_TIME_SLOTS)[number], string> = {
  MORNING: 'Por la mañana (9 a 13 h)',
  AFTERNOON: 'Por la tarde (14 a 18 h)',
  ANY: 'Cualquier horario',
}

export const CAVALI_REGISTRATION = ['YES', 'NO', 'UNKNOWN'] as const

const mobileSchema = z
  .string()
  .trim()
  .regex(/^9\d{8}$/, { error: 'El celular debe tener 9 dígitos y empezar con 9.' })

const emailSchema = z.string().trim().toLowerCase().pipe(z.email({ error: 'El correo no es válido.' }))

const contactSchema = z
  .object({
    fullName: z.string().trim().min(3, 'Escribe tu nombre completo.').max(120),
    dni: dniSchema,
    mobile: mobileSchema,
    email: emailSchema,
    isLegalRepresentative: z.boolean(),
    jobTitle: z.string().trim().min(2).max(80).optional(),
    contactTimeSlot: z.enum(CONTACT_TIME_SLOTS),
  })
  .superRefine((c, ctx) => {
    if (!c.isLegalRepresentative && !c.jobTitle) {
      ctx.addIssue({ code: 'custom', path: ['jobTitle'], message: 'Indica tu cargo en la empresa.' })
    }
  })

const utmSchema = z.record(z.string().regex(/^utm_[a-z_]+$/), z.string().trim().max(200))

/** Campo JSON del `multipart/form-data` de `POST /advance-requests`. Los archivos van aparte. */
export const advanceRequestFormSchema = z.object({
  contact: contactSchema,
  company: z.object({
    ruc: rucSchema,
    legalName: z.string().trim().min(3).max(200),
  }),
  financing: z.object({
    requestedAmount: amountSchema,
    purpose: z.string().trim().max(500).optional(),
  }),
  cavaliRegistration: z.enum(CAVALI_REGISTRATION),
  consents: z.object({
    terms: z.literal(true, { error: 'Debes aceptar los términos y condiciones.' }),
    personalData: z.literal(true, { error: 'Debes autorizar el tratamiento de tus datos personales.' }),
    termsVersion: z.string().min(1),
    privacyVersion: z.string().min(1),
  }),
  source: z
    .object({
      utm: utmSchema.optional(),
      referrer: z.url().max(2000).optional(),
    })
    .optional(),
})
export type AdvanceRequestForm = z.infer<typeof advanceRequestFormSchema>
```

`packages/shared/src/advance-request/public-code.ts`:
```ts
export type PublicCode = { prefix: string; year: number; sequence: number }

/** `ANT-2026-000123`. El prefijo y la secuencia los da la API (config y secuencia de PostgreSQL). */
export function formatPublicCode({ prefix, year, sequence }: PublicCode): string {
  return `${prefix.toUpperCase()}-${year}-${String(sequence).padStart(6, '0')}`
}

export function parsePublicCode(text: string): PublicCode | null {
  const m = /^([A-Za-z]{2,6})-(\d{4})-(\d{6,})$/.exec(text.trim())
  if (!m) return null
  return { prefix: (m[1] ?? '').toUpperCase(), year: Number(m[2]), sequence: Number(m[3]) }
}
```

Agregar a `packages/shared/src/advance-request/index.ts`:
```ts
export {
  type AdvanceRequestForm,
  advanceRequestFormSchema,
  CAVALI_REGISTRATION,
  CONTACT_TIME_SLOT_LABELS,
  CONTACT_TIME_SLOTS,
} from './form.js'
export { formatPublicCode, parsePublicCode, type PublicCode } from './public-code.js'
```

- [ ] **Step 4: Correr tests y verificación completa**

Run: `pnpm --filter @anticipate/shared test && pnpm typecheck && pnpm lint`
Expected: todos PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src
git commit -m "feat(shared): esquema del formulario de solicitud y código público"
```

---

### Task 9: Dominios `supplier-document` y `payer`

**Files:**
- Create: `packages/shared/src/supplier-document/validity.ts`, `packages/shared/src/supplier-document/index.ts`
- Create: `packages/shared/src/payer/schema.ts`, `packages/shared/src/payer/index.ts`
- Test: `packages/shared/src/supplier-document/validity.test.ts`, `packages/shared/src/payer/schema.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `IsoDate`, `daysBetween`, `addDaysIso`, `isIsoDate` (Tarea 4); `rucSchema` (Tarea 3); `CURRENCIES` (Tarea 4).
- Produces: `SUPPLIER_DOCUMENT_TYPES`, `SUPPLIER_DOCUMENT_STATUSES`, `ValidityRules`, `computeValidUntil(type, input, rules)`, `isCurrentlyValid(doc, today)`, `requiresValidity(type)`; `publicPayerSchema`, `PublicPayer`, `isHexColor`, `slugSchema`. La API usa `computeValidUntil` al aprobar un documento y `isCurrentlyValid` en la guarda `documentsValid`; la landing recibe `PublicPayer` de `GET /payers`.

- [ ] **Step 1: Escribir los tests que fallan**

`packages/shared/src/supplier-document/validity.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { computeValidUntil, isCurrentlyValid, type ValidityRules } from './validity.js'

const rules: ValidityRules = { powerOfAttorneyValidityDays: 90 }

describe('computeValidUntil', () => {
  it('vigencia de poder: fecha de emisión más los días del contexto', () => {
    expect(computeValidUntil('POWER_OF_ATTORNEY_CERTIFICATE', { issuedOn: '2026-09-01' }, rules)).toBe('2026-11-30')
    expect(computeValidUntil('POWER_OF_ATTORNEY_CERTIFICATE', { issuedOn: '2026-09-01' }, { powerOfAttorneyValidityDays: 30 })).toBe('2026-10-01')
  })

  it('DNI: hasta su fecha de caducidad', () => {
    expect(computeValidUntil('REPRESENTATIVE_ID', { expiresOn: '2030-05-20' }, rules)).toBe('2030-05-20')
  })

  it('contrato marco y otros: sin vencimiento', () => {
    expect(computeValidUntil('MASTER_AGREEMENT', {}, rules)).toBeNull()
    expect(computeValidUntil('OTHER', {}, rules)).toBeNull()
  })

  it('lanza si falta el dato que el tipo necesita', () => {
    expect(() => computeValidUntil('POWER_OF_ATTORNEY_CERTIFICATE', {}, rules)).toThrow()
    expect(() => computeValidUntil('REPRESENTATIVE_ID', {}, rules)).toThrow()
  })
})

describe('isCurrentlyValid', () => {
  it('solo un documento aprobado y no vencido está vigente', () => {
    expect(isCurrentlyValid({ status: 'APPROVED', validUntil: '2026-12-31' }, '2026-09-23')).toBe(true)
    expect(isCurrentlyValid({ status: 'APPROVED', validUntil: '2026-09-23' }, '2026-09-23')).toBe(true)
    expect(isCurrentlyValid({ status: 'APPROVED', validUntil: '2026-09-22' }, '2026-09-23')).toBe(false)
    expect(isCurrentlyValid({ status: 'APPROVED', validUntil: null }, '2026-09-23')).toBe(true)
    expect(isCurrentlyValid({ status: 'PENDING_REVIEW', validUntil: null }, '2026-09-23')).toBe(false)
    expect(isCurrentlyValid({ status: 'REJECTED', validUntil: '2099-01-01' }, '2026-09-23')).toBe(false)
  })
})
```

`packages/shared/src/payer/schema.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { isHexColor, publicPayerSchema } from './schema.js'

const sea = {
  slug: 'sea',
  ruc: '20131312955',
  legalName: 'Servicios Energéticos Ambientales S.A.',
  shortName: 'SEA',
  advancePercent: 80,
  minTermDays: 15,
  maxInvoices: 10,
  allowedCurrencies: ['PEN', 'USD'],
  accentColor: '#0E7C86',
  logoUrl: 'https://cdn.ejemplo.pe/sea.svg',
  texts: { title: 'Adelanta tus facturas a SEA', subtitle: 'Cobra hoy lo que SEA te pagará en 60 días' },
}

describe('publicPayerSchema', () => {
  it('acepta un pagador completo', () => {
    expect(publicPayerSchema.safeParse(sea).success).toBe(true)
  })

  it('el slug es kebab-case en minúsculas', () => {
    for (const slug of ['SEA', 'sea 2', 'sea_2', '-sea']) {
      expect(publicPayerSchema.safeParse({ ...sea, slug }).success, slug).toBe(false)
    }
    expect(publicPayerSchema.safeParse({ ...sea, slug: 'sea-2' }).success).toBe(true)
  })

  it('el porcentaje está entre 1 y 100 con hasta dos decimales', () => {
    expect(publicPayerSchema.safeParse({ ...sea, advancePercent: 0 }).success).toBe(false)
    expect(publicPayerSchema.safeParse({ ...sea, advancePercent: 100.5 }).success).toBe(false)
    expect(publicPayerSchema.safeParse({ ...sea, advancePercent: 33.333 }).success).toBe(false)
    expect(publicPayerSchema.safeParse({ ...sea, advancePercent: 33.33 }).success).toBe(true)
  })

  it('logo opcional y color hexadecimal', () => {
    expect(publicPayerSchema.safeParse({ ...sea, logoUrl: null }).success).toBe(true)
    expect(publicPayerSchema.safeParse({ ...sea, accentColor: 'azul' }).success).toBe(false)
    expect(isHexColor('#abc')).toBe(true)
    expect(isHexColor('#0E7C86')).toBe(true)
    expect(isHexColor('0E7C86')).toBe(false)
  })
})
```

- [ ] **Step 2: Correr y verificar que fallan**

Run: `pnpm --filter @anticipate/shared test -- supplier-document payer`
Expected: FAIL por módulos inexistentes.

- [ ] **Step 3: Implementar `supplier-document`**

`packages/shared/src/supplier-document/validity.ts`:
```ts
import { z } from 'zod'
import { type IsoDate, addDaysIso, daysBetween, isIsoDate } from '../dates/index.js'

export const SUPPLIER_DOCUMENT_TYPES = ['REPRESENTATIVE_ID', 'POWER_OF_ATTORNEY_CERTIFICATE', 'MASTER_AGREEMENT', 'OTHER'] as const
export type SupplierDocumentType = (typeof SUPPLIER_DOCUMENT_TYPES)[number]
export const supplierDocumentTypeSchema = z.enum(SUPPLIER_DOCUMENT_TYPES)

export const SUPPLIER_DOCUMENT_STATUSES = ['PENDING_REVIEW', 'APPROVED', 'REJECTED'] as const
export type SupplierDocumentStatus = (typeof SUPPLIER_DOCUMENT_STATUSES)[number]
export const supplierDocumentStatusSchema = z.enum(SUPPLIER_DOCUMENT_STATUSES)

export const SUPPLIER_DOCUMENT_TYPE_LABELS: Record<SupplierDocumentType, string> = {
  REPRESENTATIVE_ID: 'DNI del representante legal',
  POWER_OF_ATTORNEY_CERTIFICATE: 'Vigencia de poder (SUNARP)',
  MASTER_AGREEMENT: 'Contrato marco',
  OTHER: 'Otro documento',
}

/** Parámetros de negocio; la API los toma de su configuración. */
export type ValidityRules = { powerOfAttorneyValidityDays: number }

export type ValidityInput = { issuedOn?: IsoDate; expiresOn?: IsoDate }

/** Fecha hasta la que el documento vale, o null si no vence. Lanza si falta el dato que el tipo exige. */
export function computeValidUntil(type: SupplierDocumentType, input: ValidityInput, rules: ValidityRules): IsoDate | null {
  switch (type) {
    case 'POWER_OF_ATTORNEY_CERTIFICATE': {
      if (!input.issuedOn || !isIsoDate(input.issuedOn)) throw new Error('POWER_OF_ATTORNEY_CERTIFICATE requiere issuedOn')
      return addDaysIso(input.issuedOn, rules.powerOfAttorneyValidityDays)
    }
    case 'REPRESENTATIVE_ID': {
      if (!input.expiresOn || !isIsoDate(input.expiresOn)) throw new Error('REPRESENTATIVE_ID requiere expiresOn')
      return input.expiresOn
    }
    case 'MASTER_AGREEMENT':
    case 'OTHER':
      return null
  }
}

export function requiresValidity(type: SupplierDocumentType): boolean {
  return type === 'POWER_OF_ATTORNEY_CERTIFICATE' || type === 'REPRESENTATIVE_ID'
}

export type DocumentValidity = { status: SupplierDocumentStatus; validUntil: IsoDate | null }

/** Aprobado y con `validUntil` de hoy en adelante (o sin vencimiento). */
export function isCurrentlyValid(doc: DocumentValidity, today: IsoDate): boolean {
  if (doc.status !== 'APPROVED') return false
  if (doc.validUntil === null) return true
  return daysBetween(today, doc.validUntil) >= 0
}
```

`packages/shared/src/supplier-document/index.ts`:
```ts
export {
  computeValidUntil,
  type DocumentValidity,
  isCurrentlyValid,
  requiresValidity,
  SUPPLIER_DOCUMENT_STATUSES,
  SUPPLIER_DOCUMENT_TYPE_LABELS,
  SUPPLIER_DOCUMENT_TYPES,
  type SupplierDocumentStatus,
  supplierDocumentStatusSchema,
  type SupplierDocumentType,
  supplierDocumentTypeSchema,
  type ValidityInput,
  type ValidityRules,
} from './validity.js'
```

- [ ] **Step 4: Implementar `payer`**

`packages/shared/src/payer/schema.ts`:
```ts
import { z } from 'zod'
import { rucSchema } from '../identity/index.js'
import { CURRENCIES } from '../money/index.js'

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

export function isHexColor(value: string): boolean {
  return HEX_COLOR.test(value)
}

export const slugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { error: 'El slug solo admite minúsculas, números y guiones.' })
  .max(60)

/** Lo que la landing recibe de `GET /payers`: solo campos públicos (STACK §8). */
export const publicPayerSchema = z.object({
  slug: slugSchema,
  ruc: rucSchema,
  legalName: z.string().trim().min(3).max(200),
  shortName: z.string().trim().min(2).max(40),
  advancePercent: z.number().min(1).max(100).multipleOf(0.01),
  minTermDays: z.number().int().min(0),
  maxInvoices: z.number().int().min(1),
  allowedCurrencies: z.array(z.enum(CURRENCIES)).min(1),
  accentColor: z.string().refine(isHexColor, { error: 'El color debe ser hexadecimal, por ejemplo #0E7C86.' }),
  logoUrl: z.url().nullable(),
  texts: z.record(z.string(), z.string()),
})
export type PublicPayer = z.infer<typeof publicPayerSchema>
```

`packages/shared/src/payer/index.ts`:
```ts
export { isHexColor, type PublicPayer, publicPayerSchema, slugSchema } from './schema.js'
```

Agregar a `packages/shared/src/index.ts`:
```ts
export * from './supplier-document/index.js'
export * from './payer/index.js'
```

- [ ] **Step 5: Correr tests y verificación completa**

Run: `pnpm --filter @anticipate/shared test && pnpm typecheck && pnpm lint && pnpm build`
Expected: todos PASS; `dist/` contiene las nueve carpetas de dominio con `.js` y `.d.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src
git commit -m "feat(shared): vigencia de documentos del proveedor y esquema público del pagador"
```

---

### Task 10: CI, documentación y cierre de la fase

**Files:**
- Create: `.github/workflows/ci.yml`, `README.md`
- Move: `STACK.md` → `docs/STACK.md`
- Modify: `docs/STACK.md` (secciones 4, 5, 9 y 13: convención de nombres y glosario, versiones fijadas, validación nativa de NestJS 12, `shared` en ESM, índices parciales de Prisma)

- [ ] **Step 1: Crear el workflow de CI**

`.github/workflows/ci.yml`:
```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .node-version
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build
```

- [ ] **Step 2: Mover el documento vivo a `docs/` y escribir el README**

Run: `git mv STACK.md docs/STACK.md`

`README.md`:
```markdown
# Anticipate Factoring

Adelanto de facturas para proveedores de empresas pagadoras. Documento de arquitectura: [docs/STACK.md](docs/STACK.md).

## Requisitos

- Node.js 24.15 o superior (`.node-version`)
- pnpm 12.6 o superior (`corepack enable`)

## Comandos

| Comando | Qué hace |
|---|---|
| `pnpm install` | Instala todo el monorepo |
| `pnpm lint` | Biome: linter y formato |
| `pnpm typecheck` | TypeScript en todos los paquetes |
| `pnpm test` | Vitest en todos los paquetes |
| `pnpm build` | Compila los paquetes |
| `pnpm verify` | Todo lo anterior, en orden. Es lo que corre CI |
| `pnpm test:watch` | Vitest en modo interactivo sobre todos los paquetes |

## Estructura

- `packages/shared`: esquemas, reglas de negocio, lector de XML y máquina de estados. Sin código de servidor ni de navegador.
- `packages/config`: presets de TypeScript.
- `apps/`: landing, admin y api (fases siguientes).

## Convenciones

- Código en inglés (identificadores, archivos, modelos); español en mensajes, textos, documentación, comentarios y commits. Glosario en `docs/STACK.md`.
- Las versiones se fijan en el `catalog` de `pnpm-workspace.yaml`; los `package.json` usan `catalog:`.
```

- [ ] **Step 3: Registrar en `docs/STACK.md` la convención de nombres y el glosario**

Agregar después del "Glosario" de la sección 1 un bloque nuevo:

```markdown
**Convención de nombres en el código**

Identificadores en inglés (archivos, funciones, tipos, propiedades, valores de enums, modelos y columnas), igual que en el resto de proyectos de Anticipate. Español en todo lo que lee una persona: mensajes, textos, documentación, comentarios y commits. Los términos legales peruanos sin traducción real se quedan como préstamos (`ruc`, `dni`, `sunat`, `sunarp`, `cavali`). Los literales que SUNAT define en el XML (`FormaPago`, `Credito`, `Cuota001`, `Detraccion`) no se traducen.

| Término del documento | Nombre en el código |
|---|---|
| Pagador | `Payer` |
| Proveedor | `Supplier` |
| Solicitud | `AdvanceRequest` |
| Factura, cuota | `Invoice`, `Installment` |
| Serie y número | `seriesNumber` |
| Emisor, receptor | `issuer`, `recipient` |
| Forma de pago (contado, crédito) | `paymentTerms` (`CASH`, `CREDIT`) |
| Monto neto pendiente | `netPendingAmount` |
| Detracción, retención, percepción | `detraction`, `withholding`, `perception` |
| Representante legal | `LegalRepresentative` |
| Documento del proveedor | `SupplierDocument` (`REPRESENTATIVE_ID`, `POWER_OF_ATTORNEY_CERTIFICATE`, `MASTER_AGREEMENT`, `OTHER`) |
| Seguimiento | `FollowUp` |
| Historial de estado | `StatusHistory` |
| Consentimiento | `Consent` |
| Archivo | `StoredFile` |
| Auditoría | `AuditLog` |
| Proforma, cesión, desembolso | `Quote`, `Assignment`, `Disbursement` |
| Estados de la solicitud | `NEW`, `NO_ANSWER`, `CONTACTED`, `DOCUMENTS_PENDING`, `UNDER_REVIEW`, `QUOTE_SENT`, `APPROVED`, `DISBURSED`, `REJECTED`, `WITHDRAWN` |
| Motivos de cierre | `NO_RESPONSE`, `SPAM_OR_INVALID`, `SUPPLIER_WITHDREW`, `INVALID_DOCUMENTS`, `INVOICE_NOT_ELIGIBLE`, `UNACCEPTABLE_RISK`, `OTHER` |
| Roles | `AGENT` (gestor), `ADMIN` |

Los diagramas de la sección 9 conservan los nombres en español del glosario; el `schema.prisma` (siguiente plan) usa los nombres de esta tabla.
```

- [ ] **Step 4: Registrar en `docs/STACK.md` lo que la verificación de versiones cambió**

En la sección 4, tabla "Stack por capa":
- Fila "Lenguaje": cambiar `TypeScript (modo `strict`)` por `TypeScript 6 (modo `strict`; 7.0 no lo soportan el CLI de NestJS ni @nestjs/swagger)`.
- Fila "Runtime": cambiar `Node.js LTS activo` por `Node.js 24 LTS`.
- Fila "Validación y contratos": cambiar `Zod + `nestjs-zod`` por `Zod 4 + validación nativa de NestJS 12 (Standard Schema; `nestjs-zod` no soporta NestJS 12)`.
- Fila "Documentación API": cambiar `OpenAPI (Swagger) generado desde Zod` por `OpenAPI generado por @nestjs/swagger 12 directamente desde los esquemas Zod (≥ 4.2, sin conversor)`.
- Fila "Correos": cambiar `Brevo (API transaccional) + React Email` por `Brevo (API transaccional) + React Email 6 (paquete único `react-email`)`.
- Fila "Fechas": cambiar `Guardar en UTC, mostrar en `America/Lima`` por `date-fns 4 con `@date-fns/tz`; fechas de negocio como calendario ISO, instantes en UTC, "hoy" calculado una vez en `America/Lima``.

En la sección 5, en el árbol del monorepo, renombrar la descripción de `packages/shared` a `Esquemas Zod, tipos, reglas de factura, lector UBL, máquina de estados, validadores RUC/DNI`.

En la sección 9, fila "Duplicados" de las reglas de la factura: cambiar `escrito a mano en el SQL de la migración porque Prisma no expresa índices parciales` por `declarado en `schema.prisma` con la vista previa `partialIndexes` (Prisma ≥ 7.4); un índice parcial escrito a mano en SQL lo detecta como drift`. En D26, columna "Elegido", el mismo cambio.

En la sección 13 agregar al final:

```markdown
| D30 | Compilación de `packages/shared` | `tsdown` a ESM con tipos, `exports` por dominio, imports internos con `.js` | NestJS 12 es ESM y Node ≥ 22.12 tiene `require(esm)`; un solo formato evita el "dual package hazard" y el `dist` obsoleto | Dual ESM + CJS con `tsup` (sin mantenimiento); consumir el TypeScript fuente sin build (Turbopack no resuelve `./x.js` → `x.ts`) |
| D31 | Versiones fijadas de las fundaciones | Node 24, pnpm 12, TypeScript 6 vía alias `@typescript/typescript6`, Zod 4, Vitest 5, Biome 2.5, Prisma 7.10 sin caret | Verificadas contra npm y documentación oficial el 2026-09-23; TypeScript 7 y Prisma 8 (RC) rompen dependencias del stack | Última versión de cada paquete sin mirar compatibilidad |
| D32 | Validación en la API | Standard Schema nativo de NestJS 12 (`@Body({ schema })`) | `nestjs-zod` 5.5 no soporta NestJS 12; @nestjs/swagger 12 convierte esquemas Zod ≥ 4.2 sin configuración | `nestjs-zod` (D8 queda reemplazada por esta decisión) |
| D33 | Idioma del código | Identificadores en inglés; español para personas; glosario en la sección 1 | Igual que `anticipate-health-backend` y los portales; el glosario evita traducciones inconsistentes de los términos del negocio | Todo en español (único repo distinto del resto de la empresa) |
| D34 | Fechas | date-fns 4 con `@date-fns/tz`; fechas de negocio como texto ISO de calendario; `shared` recibe "hoy" por parámetro | Misma librería que el resto de repos; las fechas de vencimiento son de calendario, no instantes; la zona horaria se aplica en un solo lugar | Aritmética de fechas propia; guardar vencimientos como timestamps |
```

Y en el historial, fila 0.4, agregar al final: `; convención de nombres en inglés con glosario (D33); date-fns (D34); versiones fijadas y validación nativa de NestJS 12 (D30 a D32); documento movido a docs/`.

- [ ] **Step 5: Verificación completa y commit**

Run: `pnpm verify`
Expected: lint, typecheck, test y build sin errores. Contar los tests: `pnpm --filter @anticipate/shared test 2>&1 | grep -E "Tests|Test Files"` debe mostrar más de 90 tests en verde.

```bash
git add .github README.md docs
git commit -m "chore: CI con GitHub Actions, README y documento vivo en docs/"
```

- [ ] **Step 6: Abrir el pull request de la fase**

Si el repositorio ya tiene remoto en GitHub: crear rama `feat/foundations-and-shared` desde el primer commit y abrir el PR contra `main`. Si aún no hay remoto, los commits quedan en `main` local y el PR se hace cuando exista.

---

## Decisiones que este plan toma y que STACK.md no tenía escritas

| Tema | Decisión | Por qué |
|---|---|---|
| Idioma del código | Inglés para identificadores, español para personas, glosario en STACK.md | Consistencia con los otros repos de Anticipate; sin traducciones inconsistentes del dominio |
| Fechas | date-fns 4 + `@date-fns/tz`; fechas ISO de calendario; "hoy" inyectado | Misma librería que el resto de repos; sin errores de medianoche; zona horaria en un solo lugar |
| Compilación de `shared` | `tsdown` a ESM con tipos, `exports` por dominio, imports con `.js` | NestJS 12 es ESM; Node ≥ 22.12 tiene `require(esm)`; un solo formato evita el dual package hazard. Turbopack no resuelve `./x.js` → `x.ts`, así que consumir fuente sin build no es opción |
| Guardas de la máquina de estados | Nombres en `shared`, hechos calculados por la API | `shared` no puede tocar Prisma; el admin recibe `allowedActions` ya resueltas |
| Motivos de cierre | Enum en `shared`, validado por estado destino | Métricas por motivo sin inventar estados (D27) |
| `supplierRuc` opcional en el contexto | La landing lee facturas antes de conocer el RUC | D22: el XML completa la empresa |
| Retención | No se lee todavía | Va en `AllowanceCharge` código 62; el neto pendiente ya viene descontado; se agrega con XML reales |
| Turborepo | Desde el día 1, sin caché remota | Ordena `build` de packages antes que apps y cachea en local; cuesta un archivo de diez líneas |
| TypeScript 6 vía alias | `typescript@npm:@typescript/typescript6` | 7.0 es `latest` pero no tiene API programática y lo rechazan el CLI de NestJS 12 y @nestjs/swagger |
| `nestjs-zod` | Descartado | No soporta NestJS 12; la validación nativa con Standard Schema lo reemplaza (paso 2) |

## Self-review (hecho al escribir el plan)

- **Cobertura de STACK.md**: §4 stack raíz (Tarea 1), §5 estructura y reglas de dependencia (Tareas 1 y 2), §9 reglas de factura (Tarea 6), estados y transiciones con motivo codificado (Tarea 7), tipos y vigencia de documentos (Tarea 9), convenciones de dinero y fechas (Tarea 4), campos del formulario §6 (Tarea 8), campos públicos del pagador §8 (Tarea 9), tests obligatorios y test estructural §12 (Tareas 3, 6, 7), CI §12 (Tarea 10), convención de nombres, glosario y versiones verificadas (Tarea 10). Fuera de este plan, a propósito: esquema Prisma, API, landing, admin, Docker Compose (pasos 2 a 4).
- **Placeholders**: los únicos valores por completar son las versiones del catálogo (Tarea 1, paso 2), que por diseño se toman de `pnpm view` en el momento de ejecutar.
- **Consistencia de nombres**: `createProblem`, `Problem`, `Amount`, `normalizeAmount`, `ParsedInvoice`, `ValidationContext`, `validateInvoices`, `evaluateStatusChange`, `availableTransitions`, `isCurrentlyValid`, `publicPayerSchema` se usan con la misma firma en todas las tareas que los mencionan.
- **Review Focus**: los cinco puntos tienen test: BOM y CRLF (Tarea 5, "robustez de formato"), prefijos de espacio de nombres y ruta legada del RUC (Tarea 5), montos sin dos decimales (Tareas 4 y 5), cuota vencida entre cuotas futuras (Tarea 6), factura repetida y emisores distintos (Tarea 6).
- **Revisión adversarial del plan** (2026-09-24, parcial por límite de sesión): corrieron los lentes de nombres e idioma; confirmaron y se corrigieron dos errores de compilación (`TRANSITIONS` tipada como `readonly Transition[]` en vez de `as const`, e `include` de `packages/shared/tsconfig.json` limitado a `src` por `rootDir`) y el script raíz pasó de `verificar` a `verify`. Pendientes de correr: APIs de librerías, tests contra código y ejecutabilidad.
- **Verificación de versiones**: hecha el 2026-09-23 con seis agentes contra el registro npm y documentación oficial (Node, pnpm, TypeScript, NestJS, Prisma, Vitest, Biome, Astro, Next.js, fast-xml-parser, SUNAT). Pins y consecuencias incorporados en Global Constraints, Tarea 1, Tarea 2 y Tarea 10.
