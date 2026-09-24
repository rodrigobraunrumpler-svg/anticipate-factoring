# Fundaciones y `packages/shared` · Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dejar listo el monorepo (pnpm, Biome, Vitest, TypeScript estricto, CI) y el paquete `@anticipate/shared` con todo el corazón del negocio testeado: validadores de identidad, dinero sin `float`, lector de XML UBL, reglas de factura parametrizadas, máquina de estados como datos, esquemas Zod del formulario y del pagador, y reglas de vigencia de documentos.

**Architecture:** `packages/shared` es un paquete isomorfo sin código de servidor ni de navegador: solo tipos, esquemas Zod y funciones puras. Todo valor de negocio variable (RUC del pagador, porcentaje de adelanto, plazo mínimo, máximo de facturas, monedas permitidas, días de vigencia de poder, fecha "hoy") entra como parámetro en un objeto de contexto; nada vive como constante. Cada dominio es una carpeta con su `index.ts` y se expone como subruta del paquete (`@anticipate/shared/factura`), así la landing importa solo lo que usa y la API lo consume compilado. Los mensajes al usuario se resuelven por código estable (`CodigoProblema`) en una tabla en español, lista para más idiomas.

**Tech Stack:** Node 24 LTS, pnpm 12 workspaces con `catalog`, Turborepo 2, TypeScript 6 en modo `strict` (nunca 7.0, ver restricciones), Biome 2.5, Vitest 5 (`projects`), Zod 4, `fast-xml-parser` 5, `tsdown` para compilar `shared` a ESM con tipos. Versiones verificadas contra el registro npm y la documentación oficial el 2026-09-23 (ver tabla al final).

**Spec:** `docs/STACK.md` (v0.4). Este plan implementa las secciones 4, 5, 9 (modelo de dominio y reglas) y las convenciones de la 12.

## Global Constraints

- TypeScript en modo `strict` con `noUncheckedIndexedAccess` y `exactOptionalPropertyTypes` en todo el monorepo (STACK §4).
- `packages/shared` no depende de nada del monorepo y no tiene código de servidor ni de navegador: solo esquemas, tipos y funciones puras (STACK §5). Dependencias de runtime permitidas: `zod` y `fast-xml-parser`. Nada más.
- Montos siempre como texto con dos decimales (`"25000.00"`); nunca `float` (STACK §9, D14). Moneda en su propia propiedad (`PEN`, `USD`).
- Fechas como texto ISO `YYYY-MM-DD` en el dominio; la conversión a hora de Lima es de las apps, no de `shared` (STACK §9).
- Las reglas de factura reciben todo parámetro de negocio por contexto: RUC del pagador, RUC del proveedor, porcentaje de adelanto, plazo mínimo en días, máximo de facturas, monedas permitidas y fecha de hoy. Ninguna constante de negocio en el código (pedido explícito: "nada hardcodeado").
- Las transiciones de estado viven en `shared` como datos con guardas nombradas; las implementaciones de las guardas viven en la API (STACK §9, reglas de la máquina de estados).
- Versiones: se fijan en el `catalog` de `pnpm-workspace.yaml` (STACK §4); ninguna versión escrita a mano en los `package.json`. Pins obligatorios, verificados el 2026-09-23: Node `>=24.15 <27` (24 es el LTS activo, 22 ya está en mantenimiento), pnpm 12.6, **TypeScript 6.0.x instalado como `typescript@npm:@typescript/typescript6`** (7.0 es `latest` pero no tiene API programática, @nestjs/cli 12 exige ~6.0 y @nestjs/swagger 12 excluye 7), Zod 4.6, fast-xml-parser ≥ 5.3.5 (corrige la CVE-2026-25896 de entidades DOCTYPE), Vitest 5, Biome 2.5, tsdown (tsup está sin mantenimiento).
- `packages/shared` se compila a ESM con tipos usando `tsdown`, sin CJS: NestJS 12 es ESM y Node ≥ 22.12 tiene `require(esm)` estable. Los imports internos llevan extensión `.js` (estilo NodeNext); Vitest los resuelve desde fuente y las apps consumen `dist`.
- pnpm 12: la configuración vive en `pnpm-workspace.yaml`, no en `.npmrc` (desde pnpm 11 `.npmrc` es solo registro y auth). `catalogMode: strict`. Los paquetes con scripts de instalación se aprueban con `pnpm approve-builds`.
- El XML se procesa sin resolver entidades (STACK §11): `processEntities: false`.
- Mensajes al usuario final en español (STACK §8, convenciones).
- Commits con Conventional Commits (STACK §12). Cada tarea termina en un commit.
- Todo archivo nuevo pasa `biome check`, `tsc --noEmit` y `vitest run` antes del commit.

## Review Focus

1. **XML con BOM, declaración `<?xml … encoding="ISO-8859-1"?>` o saltos de línea de Windows.** Los sistemas de facturación exportan de todo; el lector debe leerlo igual. Test en la Tarea 5.
2. **XML con prefijos de espacio de nombres distintos (`n1:Invoice`, sin prefijo, o `ns2:`).** El mismo comprobante llega con prefijos diferentes según el emisor; el lector no puede depender de `cbc:`/`cac:`. Test en la Tarea 5.
3. **Montos del XML sin dos decimales (`1180.5`, `1180`).** UBL no obliga a dos decimales; el dominio sí. Test en la Tarea 4 (`normalizarMonto`) y en la Tarea 5.
4. **Factura con varias cuotas donde una ya venció y otras no.** La regla debe señalar la cuota vencida, no aprobar por la primera futura. Test en la Tarea 6.
5. **La misma factura dos veces en la misma solicitud, o dos facturas de emisores distintos.** Debe rechazarse antes de tocar la base de datos. Test en la Tarea 6.

---

## Estructura de archivos

```
anticipate-factoring/
├── .github/workflows/ci.yml            Lint, tipos, tests y build en cada PR y en main
├── .vscode/extensions.json             Recomienda Biome al abrir el repo
├── .editorconfig                       Indentación y finales de línea para cualquier editor
├── .node-version                       Versión de Node para nvm/fnm/volta
├── turbo.json                          Grafo de tareas: build de packages antes que apps, caché local
├── biome.json                          Linter y formateador de todo el monorepo
├── package.json                        Scripts raíz: lint, typecheck, test, build, verificar
├── pnpm-workspace.yaml                 Workspaces + catálogo de versiones (único lugar con versiones)
├── tsconfig.json                       Solución con referencias a los paquetes
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
        │   └── factura-credito-pen.xml XML de referencia con forma legible
        └── src/
            ├── index.ts                Reexporta todos los dominios
            ├── errores/                Códigos de problema y mensajes en español
            │   ├── index.ts
            │   ├── codigos.ts
            │   ├── mensajes.es.ts
            │   └── problema.ts (+ problema.test.ts)
            ├── identidad/              RUC y DNI: validación y esquemas Zod
            │   ├── index.ts
            │   ├── ruc.ts (+ ruc.test.ts)
            │   └── dni.ts (+ dni.test.ts)
            ├── dinero/                 Monedas y montos como texto, aritmética en céntimos (bigint)
            │   ├── index.ts
            │   ├── moneda.ts
            │   └── monto.ts (+ monto.test.ts)
            ├── fechas/                 Fechas ISO sin zona horaria, diferencia en días
            │   ├── index.ts
            │   └── fecha-iso.ts (+ fecha-iso.test.ts)
            ├── factura/                Códigos SUNAT, forma de la factura leída, lector UBL, reglas
            │   ├── index.ts
            │   ├── codigos.ts
            │   ├── factura-leida.ts
            │   ├── lector-ubl.ts (+ lector-ubl.test.ts)
            │   ├── construir-xml-prueba.ts   Fábrica de XML para tests (también la usará la landing en modo demo)
            │   └── reglas.ts (+ reglas.test.ts)
            ├── solicitud/              Estados, motivos de cierre, transiciones, esquema del formulario, código público
            │   ├── index.ts
            │   ├── estados.ts
            │   ├── motivos.ts
            │   ├── transiciones.ts (+ transiciones.test.ts)
            │   ├── formulario.ts (+ formulario.test.ts)
            │   └── codigo.ts (+ codigo.test.ts)
            ├── documento/              Tipos, estados y vigencia de documentos del proveedor
            │   ├── index.ts
            │   └── vigencia.ts (+ vigencia.test.ts)
            ├── pagador/                Esquema público del pagador (lo que la landing recibe)
            │   ├── index.ts
            │   └── esquema.ts (+ esquema.test.ts)
            └── usuario/                Roles y jerarquía
                ├── index.ts
                └── roles.ts (+ roles.test.ts)
```

**Principios que aplican a todos los archivos de `shared`**

- Un archivo, una responsabilidad. Los tests van al lado del código (`x.test.ts`).
- Exportar tipos derivados de constantes `as const`, nunca duplicar listas en un `enum` de TS y en un array.
- Funciones puras: sin `Date.now()`, sin `process.env`, sin `fetch`, sin `window`. La fecha de hoy se recibe por parámetro.
- Toda validación devuelve `Problema` con código estable; el texto sale de `mensajes.es.ts`. La API y la landing muestran el mensaje; los tests comparan códigos.
- Nombres en español, en `camelCase` para código y en `snake_case` solo cuando toque la base de datos (paso 2).

---

### Task 1: Raíz del monorepo

**Files:**
- Create: `pnpm-workspace.yaml`, `package.json`, `turbo.json`, `.node-version`, `.editorconfig`, `tsconfig.json`, `biome.json`, `vitest.config.ts`, `.vscode/extensions.json`

**Interfaces:**
- Produces: el catálogo de versiones `catalog:` que todos los `package.json` usan; los scripts raíz `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm verificar`.

- [ ] **Step 1: Confirmar Node y pnpm**

Run: `node --version && pnpm --version`
Expected: Node 24.15 o superior (24 es el LTS activo; 22 ya está en mantenimiento). pnpm 12.6 o superior. Si pnpm falta: `corepack enable && corepack prepare pnpm@latest --activate` (Corepack viene con Node 24).

- [ ] **Step 2: Obtener las últimas versiones estables para el catálogo**

Run:
```bash
printf 'typescript (alias 6.x): %s\n' "$(pnpm view @typescript/typescript6 version)"
for p in zod fast-xml-parser vitest @biomejs/biome @types/node tsdown turbo; do
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
    "verificar": "pnpm lint && turbo run typecheck test build"
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

`tsconfig.json` (solo para que el editor entienda los archivos de configuración de la raíz):
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

### Task 2: `packages/config`, esqueleto de `packages/shared` y dominio `errores`

**Files:**
- Create: `packages/config/package.json`, `packages/config/tsconfig.base.json`, `packages/config/tsconfig.library.json`, `packages/config/tsconfig.node.json`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/tsdown.config.ts`, `packages/shared/vitest.config.ts`, `packages/shared/src/index.ts`
- Create: `packages/shared/src/errores/codigos.ts`, `packages/shared/src/errores/mensajes.es.ts`, `packages/shared/src/errores/problema.ts`, `packages/shared/src/errores/index.ts`
- Test: `packages/shared/src/errores/problema.test.ts`

**Interfaces:**
- Produces: `CodigoProblema` (unión de códigos), `Problema = { codigo, mensaje, factura?, campo? }`, `crearProblema(codigo, extra?)`, `MENSAJES_ES`. Todas las tareas siguientes devuelven `Problema` para señalar errores de negocio.

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
    "./errores": { "types": "./dist/errores/index.d.ts", "default": "./dist/errores/index.js" },
    "./identidad": { "types": "./dist/identidad/index.d.ts", "default": "./dist/identidad/index.js" },
    "./dinero": { "types": "./dist/dinero/index.d.ts", "default": "./dist/dinero/index.js" },
    "./fechas": { "types": "./dist/fechas/index.d.ts", "default": "./dist/fechas/index.js" },
    "./factura": { "types": "./dist/factura/index.d.ts", "default": "./dist/factura/index.js" },
    "./solicitud": { "types": "./dist/solicitud/index.d.ts", "default": "./dist/solicitud/index.js" },
    "./documento": { "types": "./dist/documento/index.d.ts", "default": "./dist/documento/index.js" },
    "./pagador": { "types": "./dist/pagador/index.d.ts", "default": "./dist/pagador/index.js" },
    "./usuario": { "types": "./dist/usuario/index.d.ts", "default": "./dist/usuario/index.js" }
  },
  "scripts": {
    "build": "tsdown",
    "dev": "tsdown --watch",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
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
  "include": ["src", "tsdown.config.ts", "vitest.config.ts"]
}
```

`packages/shared/tsdown.config.ts`:
```ts
import { defineConfig } from 'tsdown'

const dominios = [
  'errores',
  'identidad',
  'dinero',
  'fechas',
  'factura',
  'solicitud',
  'documento',
  'pagador',
  'usuario',
] as const

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    ...Object.fromEntries(dominios.map((d) => [`${d}/index`, `src/${d}/index.ts`])),
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
export * from './errores/index.js'
```

- [ ] **Step 3: Escribir el test que falla para `crearProblema`**

`packages/shared/src/errores/problema.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { CODIGOS_PROBLEMA } from './codigos.js'
import { MENSAJES_ES } from './mensajes.es.js'
import { crearProblema } from './problema.js'

describe('crearProblema', () => {
  it('devuelve el código y el mensaje en español', () => {
    const p = crearProblema('RUC_INVALIDO', { campo: 'ruc' })
    expect(p).toEqual({ codigo: 'RUC_INVALIDO', mensaje: 'El RUC no es válido.', campo: 'ruc' })
  })

  it('interpola datos en el mensaje', () => {
    const p = crearProblema('DEMASIADAS_FACTURAS', { datos: { maximo: 10 } })
    expect(p.mensaje).toBe('Puedes enviar como máximo 10 facturas por solicitud.')
  })

  it('omite las propiedades opcionales que no se pasan', () => {
    const p = crearProblema('SIN_FACTURAS')
    expect(Object.keys(p)).toEqual(['codigo', 'mensaje'])
  })

  it('todo código tiene mensaje', () => {
    for (const codigo of CODIGOS_PROBLEMA) {
      expect(MENSAJES_ES[codigo], codigo).toBeTypeOf('string')
    }
  })
})
```

- [ ] **Step 4: Correr el test y verificar que falla**

Run: `pnpm install && pnpm --filter @anticipate/shared test`
Expected: FAIL, "Cannot find module './codigos.js'" (o equivalente).

- [ ] **Step 5: Implementar códigos, mensajes y `crearProblema`**

`packages/shared/src/errores/codigos.ts`:
```ts
/** Códigos estables de problemas de negocio. La API y la landing muestran el mensaje; los tests comparan el código. */
export const CODIGOS_PROBLEMA = [
  // identidad
  'RUC_INVALIDO',
  'DNI_INVALIDO',
  // lectura del XML
  'XML_ILEGIBLE',
  'XML_NO_ES_FACTURA',
  'XML_SIN_DATO_OBLIGATORIO',
  // reglas por factura
  'TIPO_COMPROBANTE_NO_PERMITIDO',
  'RECEPTOR_NO_ES_PAGADOR',
  'EMISOR_NO_ES_PROVEEDOR',
  'FACTURA_AL_CONTADO',
  'SIN_MONTO_PENDIENTE',
  'MONEDA_NO_PERMITIDA',
  'CUOTA_VENCIDA',
  'PLAZO_INSUFICIENTE',
  // reglas del conjunto
  'SIN_FACTURAS',
  'DEMASIADAS_FACTURAS',
  'EMISORES_DISTINTOS',
  'MONEDAS_DISTINTAS',
  'FACTURA_REPETIDA',
  // monto solicitado
  'MONTO_INVALIDO',
  'MONTO_SUPERA_MAXIMO',
] as const

export type CodigoProblema = (typeof CODIGOS_PROBLEMA)[number]
```

`packages/shared/src/errores/mensajes.es.ts`:
```ts
import type { CodigoProblema } from './codigos.js'

/** Mensajes para el usuario final. Los marcadores `{nombre}` se reemplazan con `datos`. */
export const MENSAJES_ES: Record<CodigoProblema, string> = {
  RUC_INVALIDO: 'El RUC no es válido.',
  DNI_INVALIDO: 'El DNI debe tener 8 dígitos.',
  XML_ILEGIBLE: 'No pudimos leer el archivo XML. Verifica que sea el XML original de la factura.',
  XML_NO_ES_FACTURA: 'El archivo no es una factura electrónica ({tipo}).',
  XML_SIN_DATO_OBLIGATORIO: 'El XML no contiene el dato "{dato}".',
  TIPO_COMPROBANTE_NO_PERMITIDO: 'Solo aceptamos facturas electrónicas (tipo 01). Este comprobante es de tipo {tipo}.',
  RECEPTOR_NO_ES_PAGADOR: 'La factura no está emitida a {pagador}.',
  EMISOR_NO_ES_PROVEEDOR: 'La factura fue emitida por otro RUC ({emisor}), no por el de tu empresa.',
  FACTURA_AL_CONTADO: 'La factura es al contado; solo podemos adelantar facturas al crédito.',
  SIN_MONTO_PENDIENTE: 'La factura no declara un monto neto pendiente de pago.',
  MONEDA_NO_PERMITIDA: 'No trabajamos con la moneda {moneda}.',
  CUOTA_VENCIDA: 'La cuota {cuota} venció el {fecha}.',
  PLAZO_INSUFICIENTE: 'La cuota {cuota} vence en menos de {dias} días.',
  SIN_FACTURAS: 'Adjunta al menos una factura.',
  DEMASIADAS_FACTURAS: 'Puedes enviar como máximo {maximo} facturas por solicitud.',
  EMISORES_DISTINTOS: 'Todas las facturas deben ser de la misma empresa emisora.',
  MONEDAS_DISTINTAS: 'Todas las facturas de una solicitud deben estar en la misma moneda.',
  FACTURA_REPETIDA: 'La factura {factura} está repetida en esta solicitud.',
  MONTO_INVALIDO: 'El monto debe ser un número mayor que cero con dos decimales.',
  MONTO_SUPERA_MAXIMO: 'El monto solicitado supera el máximo de {maximo} {moneda}.',
}
```

`packages/shared/src/errores/problema.ts`:
```ts
import type { CodigoProblema } from './codigos.js'
import { MENSAJES_ES } from './mensajes.es.js'

export type Problema = {
  codigo: CodigoProblema
  mensaje: string
  /** Serie-número de la factura a la que se refiere, si aplica. */
  factura?: string
  /** Campo del formulario al que se refiere, si aplica. */
  campo?: string
}

export type ExtraProblema = {
  factura?: string
  campo?: string
  datos?: Record<string, string | number>
}

function interpolar(plantilla: string, datos: Record<string, string | number> = {}): string {
  return plantilla.replace(/\{(\w+)\}/g, (marca, clave: string) => {
    const valor = datos[clave]
    return valor === undefined ? marca : String(valor)
  })
}

export function crearProblema(codigo: CodigoProblema, extra: ExtraProblema = {}): Problema {
  const problema: Problema = { codigo, mensaje: interpolar(MENSAJES_ES[codigo], extra.datos) }
  if (extra.factura !== undefined) problema.factura = extra.factura
  if (extra.campo !== undefined) problema.campo = extra.campo
  return problema
}
```

`packages/shared/src/errores/index.ts`:
```ts
export { CODIGOS_PROBLEMA, type CodigoProblema } from './codigos.js'
export { MENSAJES_ES } from './mensajes.es.js'
export { crearProblema, type ExtraProblema, type Problema } from './problema.js'
```

- [ ] **Step 6: Correr tests, tipos, lint y build**

Run: `pnpm --filter @anticipate/shared test && pnpm typecheck && pnpm lint && pnpm build`
Expected: 4 tests PASS; `tsc` sin errores; Biome sin errores; `dist/` con `index.js`, `index.d.ts` y la carpeta `errores/`. Sin `.cjs`.

- [ ] **Step 7: Commit**

```bash
git add packages/config packages/shared pnpm-lock.yaml
git commit -m "feat(shared): esqueleto del paquete y dominio de errores con mensajes en español"
```

---

### Task 3: Dominio `identidad` (RUC y DNI)

**Files:**
- Create: `packages/shared/src/identidad/ruc.ts`, `packages/shared/src/identidad/dni.ts`, `packages/shared/src/identidad/index.ts`
- Test: `packages/shared/src/identidad/ruc.test.ts`, `packages/shared/src/identidad/dni.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `MENSAJES_ES` de la Tarea 2.
- Produces: `esRucValido(valor: string): boolean`, `rucSchema: ZodString`, `esDniValido(valor: string): boolean`, `dniSchema: ZodString`. El formulario (Tarea 8) y las reglas (Tarea 6) los usan.

- [ ] **Step 1: Escribir los tests que fallan**

`packages/shared/src/identidad/ruc.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { esRucValido, rucSchema } from './ruc.js'

describe('esRucValido', () => {
  it.each([
    ['20100070970', 'empresa (prefijo 20)'],
    ['20131312955', 'entidad pública (prefijo 20)'],
    ['10467286736', 'persona natural con negocio (prefijo 10)'],
  ])('acepta %s (%s)', (ruc) => {
    expect(esRucValido(ruc)).toBe(true)
  })

  it.each([
    ['20100070971', 'dígito verificador incorrecto'],
    ['12345678901', 'prefijo no válido'],
    ['2010007097', 'diez dígitos'],
    ['201000709700', 'doce dígitos'],
    ['2010007097A', 'con letra'],
    ['', 'vacío'],
  ])('rechaza %s (%s)', (ruc) => {
    expect(esRucValido(ruc)).toBe(false)
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

`packages/shared/src/identidad/dni.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { dniSchema, esDniValido } from './dni.js'

describe('esDniValido', () => {
  it('acepta 8 dígitos', () => {
    expect(esDniValido('46728673')).toBe(true)
    expect(esDniValido('00000001')).toBe(true)
  })

  it.each(['4672867', '467286731', '4672867A', ''])('rechaza %s', (dni) => {
    expect(esDniValido(dni)).toBe(false)
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

Run: `pnpm --filter @anticipate/shared test -- identidad`
Expected: FAIL por módulos inexistentes.

- [ ] **Step 3: Implementar**

`packages/shared/src/identidad/ruc.ts`:
```ts
import { z } from 'zod'
import { MENSAJES_ES } from '../errores/index.js'

/** Pesos del algoritmo módulo 11 de SUNAT para los diez primeros dígitos. */
const PESOS = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2] as const

/** Prefijos que SUNAT asigna: 10 persona natural, 15/16/17 otros tipos, 20 persona jurídica. */
const PREFIJOS_VALIDOS = new Set(['10', '15', '16', '17', '20'])

export function esRucValido(valor: string): boolean {
  if (!/^\d{11}$/.test(valor)) return false
  if (!PREFIJOS_VALIDOS.has(valor.slice(0, 2))) return false
  const suma = PESOS.reduce((acc, peso, i) => acc + peso * Number(valor[i]), 0)
  const resto = 11 - (suma % 11)
  const verificador = resto === 10 ? 0 : resto === 11 ? 1 : resto
  return verificador === Number(valor[10])
}

export const rucSchema = z
  .string()
  .trim()
  .refine(esRucValido, { error: MENSAJES_ES.RUC_INVALIDO })
```

`packages/shared/src/identidad/dni.ts`:
```ts
import { z } from 'zod'
import { MENSAJES_ES } from '../errores/index.js'

export function esDniValido(valor: string): boolean {
  return /^\d{8}$/.test(valor)
}

export const dniSchema = z
  .string()
  .trim()
  .refine(esDniValido, { error: MENSAJES_ES.DNI_INVALIDO })
```

`packages/shared/src/identidad/index.ts`:
```ts
export { dniSchema, esDniValido } from './dni.js'
export { esRucValido, rucSchema } from './ruc.js'
```

Agregar a `packages/shared/src/index.ts`:
```ts
export * from './identidad/index.js'
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

### Task 4: Dominios `dinero` y `fechas`

**Files:**
- Create: `packages/shared/src/dinero/moneda.ts`, `packages/shared/src/dinero/monto.ts`, `packages/shared/src/dinero/index.ts`
- Create: `packages/shared/src/fechas/fecha-iso.ts`, `packages/shared/src/fechas/index.ts`
- Test: `packages/shared/src/dinero/monto.test.ts`, `packages/shared/src/fechas/fecha-iso.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces: `MONEDAS`, `Moneda`, `monedaSchema`; `Monto` (texto `"25000.00"`), `montoSchema`, `normalizarMonto(valor): Monto | null`, `aCentimos(m): bigint`, `deCentimos(c): Monto`, `sumarMontos(...m): Monto`, `porcentajeDe(m, pct): Monto`, `compararMontos(a, b): -1 | 0 | 1`; `fechaIsoSchema`, `esFechaIso(v)`, `diasEntre(desde, hasta): number`.

- [ ] **Step 1: Escribir los tests que fallan**

`packages/shared/src/dinero/monto.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import {
  aCentimos,
  compararMontos,
  deCentimos,
  montoSchema,
  normalizarMonto,
  porcentajeDe,
  sumarMontos,
} from './monto.js'

describe('normalizarMonto', () => {
  it.each([
    ['1180.5', '1180.50'],
    ['1180', '1180.00'],
    ['0.1', '0.10'],
    [1180.5, '1180.50'],
    [' 25000.00 ', '25000.00'],
  ])('convierte %s en %s', (entrada, esperado) => {
    expect(normalizarMonto(entrada)).toBe(esperado)
  })

  it.each(['', 'abc', '-5.00', '1,180.50', '1.234', Number.NaN])('rechaza %s', (entrada) => {
    expect(normalizarMonto(entrada)).toBeNull()
  })
})

describe('aritmética en céntimos', () => {
  it('convierte ida y vuelta sin perder precisión', () => {
    expect(aCentimos('25000.00')).toBe(25_000_00n)
    expect(deCentimos(25_000_00n)).toBe('25000.00')
    expect(deCentimos(5n)).toBe('0.05')
    expect(deCentimos(0n)).toBe('0.00')
  })

  it('suma sin errores de coma flotante', () => {
    expect(sumarMontos('0.10', '0.20')).toBe('0.30')
    expect(sumarMontos('10620.00', '5310.50', '0.01')).toBe('15930.51')
  })

  it('calcula porcentajes redondeando hacia abajo al céntimo', () => {
    expect(porcentajeDe('10620.00', 80)).toBe('8496.00')
    expect(porcentajeDe('100.00', 33.33)).toBe('33.33')
    expect(porcentajeDe('0.01', 50)).toBe('0.00')
  })

  it('compara montos', () => {
    expect(compararMontos('100.00', '100.00')).toBe(0)
    expect(compararMontos('99.99', '100.00')).toBe(-1)
    expect(compararMontos('100.01', '100.00')).toBe(1)
  })
})

describe('montoSchema', () => {
  it('acepta solo texto con dos decimales y mayor que cero', () => {
    expect(montoSchema.safeParse('25000.00').success).toBe(true)
    expect(montoSchema.safeParse('0.00').success).toBe(false)
    expect(montoSchema.safeParse('25000').success).toBe(false)
    expect(montoSchema.safeParse(25000).success).toBe(false)
  })
})
```

`packages/shared/src/fechas/fecha-iso.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { diasEntre, esFechaIso, fechaIsoSchema } from './fecha-iso.js'

describe('esFechaIso', () => {
  it.each(['2026-09-23', '2024-02-29'])('acepta %s', (v) => {
    expect(esFechaIso(v)).toBe(true)
  })

  it.each(['2026-9-3', '23/09/2026', '2026-13-01', '2023-02-29', '2026-09-23T00:00:00Z', ''])(
    'rechaza %s',
    (v) => {
      expect(esFechaIso(v)).toBe(false)
    },
  )
})

describe('diasEntre', () => {
  it('cuenta días de calendario sin zona horaria', () => {
    expect(diasEntre('2026-09-23', '2026-09-23')).toBe(0)
    expect(diasEntre('2026-09-23', '2026-10-08')).toBe(15)
    expect(diasEntre('2026-09-23', '2026-09-22')).toBe(-1)
    expect(diasEntre('2026-02-28', '2026-03-01')).toBe(1)
  })
})

describe('fechaIsoSchema', () => {
  it('rechaza con mensaje en español', () => {
    const r = fechaIsoSchema.safeParse('23/09/2026')
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0]?.message).toBe('La fecha debe tener el formato AAAA-MM-DD.')
  })
})
```

- [ ] **Step 2: Correr y verificar que fallan**

Run: `pnpm --filter @anticipate/shared test -- dinero fechas`
Expected: FAIL por módulos inexistentes.

- [ ] **Step 3: Implementar `dinero`**

`packages/shared/src/dinero/moneda.ts`:
```ts
import { z } from 'zod'

/** Monedas que el sistema sabe representar. Cuáles acepta cada pagador es un dato de contexto, no una constante. */
export const MONEDAS = ['PEN', 'USD'] as const
export type Moneda = (typeof MONEDAS)[number]
export const monedaSchema = z.enum(MONEDAS)
```

`packages/shared/src/dinero/monto.ts`:
```ts
import { z } from 'zod'
import { MENSAJES_ES } from '../errores/index.js'

/** Monto como texto con exactamente dos decimales, por ejemplo "25000.00". Nunca `number`. */
export type Monto = string

const FORMATO_MONTO = /^\d{1,13}\.\d{2}$/

/** Acepta lo que venga de un XML o de un input y lo lleva a `Monto`. Devuelve null si no es un número no negativo. */
export function normalizarMonto(valor: string | number): Monto | null {
  const texto = typeof valor === 'number' ? (Number.isFinite(valor) ? valor.toString() : '') : valor.trim()
  const partes = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(texto)
  if (!partes) return null
  const entero = partes[1] ?? '0'
  const decimales = (partes[2] ?? '').padEnd(2, '0')
  return `${entero}.${decimales}`
}

export function aCentimos(monto: Monto): bigint {
  const [entero = '0', decimales = '00'] = monto.split('.')
  return BigInt(entero) * 100n + BigInt(decimales.padEnd(2, '0').slice(0, 2))
}

export function deCentimos(centimos: bigint): Monto {
  const texto = centimos.toString().padStart(3, '0')
  return `${texto.slice(0, -2)}.${texto.slice(-2)}`
}

export function sumarMontos(...montos: Monto[]): Monto {
  return deCentimos(montos.reduce((acc, m) => acc + aCentimos(m), 0n))
}

/** `pct` en escala 0 a 100, con hasta dos decimales (80, 33.33). Redondea hacia abajo al céntimo. */
export function porcentajeDe(monto: Monto, pct: number): Monto {
  const pctEnCentesimas = BigInt(Math.round(pct * 100))
  return deCentimos((aCentimos(monto) * pctEnCentesimas) / 10_000n)
}

export function compararMontos(a: Monto, b: Monto): -1 | 0 | 1 {
  const ca = aCentimos(a)
  const cb = aCentimos(b)
  return ca < cb ? -1 : ca > cb ? 1 : 0
}

/** Monto ingresado por una persona: dos decimales obligatorios y mayor que cero. */
export const montoSchema = z
  .string()
  .trim()
  .refine((v) => FORMATO_MONTO.test(v) && aCentimos(v) > 0n, { error: MENSAJES_ES.MONTO_INVALIDO })
```

`packages/shared/src/dinero/index.ts`:
```ts
export { MONEDAS, type Moneda, monedaSchema } from './moneda.js'
export {
  aCentimos,
  compararMontos,
  deCentimos,
  type Monto,
  montoSchema,
  normalizarMonto,
  porcentajeDe,
  sumarMontos,
} from './monto.js'
```

- [ ] **Step 4: Implementar `fechas`**

`packages/shared/src/fechas/fecha-iso.ts`:
```ts
import { z } from 'zod'

/** Fecha de calendario sin hora ni zona: "2026-09-23". */
export type FechaIso = string

const FORMATO = /^(\d{4})-(\d{2})-(\d{2})$/

function aUtc(fecha: FechaIso): number | null {
  const m = FORMATO.exec(fecha)
  if (!m) return null
  const anio = Number(m[1])
  const mes = Number(m[2])
  const dia = Number(m[3])
  const ms = Date.UTC(anio, mes - 1, dia)
  const d = new Date(ms)
  const valida = d.getUTCFullYear() === anio && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia
  return valida ? ms : null
}

export function esFechaIso(valor: string): boolean {
  return aUtc(valor) !== null
}

/** Días de calendario de `desde` a `hasta`. Negativo si `hasta` es anterior. Lanza si alguna fecha es inválida. */
export function diasEntre(desde: FechaIso, hasta: FechaIso): number {
  const a = aUtc(desde)
  const b = aUtc(hasta)
  if (a === null || b === null) throw new Error(`Fecha inválida: ${a === null ? desde : hasta}`)
  return Math.round((b - a) / 86_400_000)
}

export const fechaIsoSchema = z
  .string()
  .trim()
  .refine(esFechaIso, { error: 'La fecha debe tener el formato AAAA-MM-DD.' })
```

`packages/shared/src/fechas/index.ts`:
```ts
export { diasEntre, esFechaIso, type FechaIso, fechaIsoSchema } from './fecha-iso.js'
```

Agregar a `packages/shared/src/index.ts`:
```ts
export * from './dinero/index.js'
export * from './fechas/index.js'
```

- [ ] **Step 5: Correr tests y verificación completa**

Run: `pnpm --filter @anticipate/shared test && pnpm typecheck && pnpm lint`
Expected: todos PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src
git commit -m "feat(shared): montos como texto con aritmética en céntimos y fechas ISO"
```

---

### Task 5: Dominio `factura` · códigos, forma de la factura leída, fábrica de XML y lector UBL

**Files:**
- Create: `packages/shared/src/factura/codigos.ts`, `packages/shared/src/factura/factura-leida.ts`, `packages/shared/src/factura/construir-xml-prueba.ts`, `packages/shared/src/factura/lector-ubl.ts`, `packages/shared/src/factura/index.ts`
- Create: `packages/shared/test/fixtures/factura-credito-pen.xml`
- Test: `packages/shared/src/factura/lector-ubl.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `Monto`, `normalizarMonto` (Tarea 4); `FechaIso`, `esFechaIso` (Tarea 4); `crearProblema`, `Problema` (Tarea 2).
- Produces: `TIPO_COMPROBANTE`, `FORMAS_PAGO`, `FormaPago`; `FacturaLeida`, `Cuota`, `facturaLeidaSchema`; `construirXmlFactura(opciones)`, `construirXmlCdr()`; `decodificarXml(bytes: Uint8Array): string`; `leerFacturaUbl(xml: string): ResultadoLectura` con `ResultadoLectura = { ok: true; factura: FacturaLeida } | { ok: false; problema: Problema }`. La Tarea 6 (reglas) consume `FacturaLeida`.

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

Un CDR (constancia de recepción de SUNAT) tiene raíz `ApplicationResponse`; una nota de crédito, `CreditNote`. Ninguna es factura. La retención del IGV no va en `PaymentTerms` sino en `Invoice.AllowanceCharge` con código 62 del catálogo 53 (verificado en la guía de SUNAT); se lee en una fase posterior porque el neto pendiente ya viene descontado. La forma de pago es obligatoria solo en facturas emitidas desde el 2021-09-01 (RS 042-2021): una factura anterior sin `FormaPago` no tiene neto pendiente declarado y las reglas la rechazan, que es lo correcto para factoring.

- [ ] **Step 1: Códigos y forma de la factura leída**

`packages/shared/src/factura/codigos.ts`:
```ts
/** Catálogo 01 de SUNAT: tipo de comprobante. */
export const TIPO_COMPROBANTE = {
  FACTURA: '01',
  BOLETA: '03',
  NOTA_CREDITO: '07',
  NOTA_DEBITO: '08',
} as const
export type TipoComprobante = (typeof TIPO_COMPROBANTE)[keyof typeof TIPO_COMPROBANTE]

export const NOMBRE_TIPO_COMPROBANTE: Record<string, string> = {
  '01': 'factura',
  '03': 'boleta de venta',
  '07': 'nota de crédito',
  '08': 'nota de débito',
}

export const FORMAS_PAGO = ['CONTADO', 'CREDITO'] as const
export type FormaPago = (typeof FORMAS_PAGO)[number]
```

`packages/shared/src/factura/factura-leida.ts`:
```ts
import { z } from 'zod'
import { montoSchema } from '../dinero/index.js'
import { fechaIsoSchema } from '../fechas/index.js'
import { FORMAS_PAGO } from './codigos.js'

const montoLeidoSchema = z.string().regex(/^\d{1,13}\.\d{2}$/)

export const cuotaSchema = z.object({
  id: z.string().min(1),
  monto: montoLeidoSchema,
  vence: fechaIsoSchema,
})
export type Cuota = z.infer<typeof cuotaSchema>

/** Lo que el lector extrae de un XML. Es la forma que viaja entre landing, API y admin. */
export const facturaLeidaSchema = z.object({
  tipoComprobante: z.string().min(1),
  serieNumero: z.string().min(1),
  fechaEmision: fechaIsoSchema,
  moneda: z.string().length(3),
  rucEmisor: z.string().min(1),
  razonSocialEmisor: z.string(),
  rucReceptor: z.string().min(1),
  razonSocialReceptor: z.string().nullable(),
  /** Total a pagar del comprobante. Puede ser 0.00 en casos raros; por eso no usa montoSchema. */
  total: montoLeidoSchema,
  formaPago: z.enum(FORMAS_PAGO).nullable(),
  /** Solo al crédito: monto neto pendiente de pago declarado en el XML (ya descuenta detracción o retención). */
  montoNetoPendiente: montoLeidoSchema.nullable(),
  cuotas: z.array(cuotaSchema),
  detraccion: z.object({ porcentaje: z.number().min(0).max(100), monto: montoLeidoSchema }).nullable(),
  firmada: z.boolean(),
})
export type FacturaLeida = z.infer<typeof facturaLeidaSchema>

export { montoSchema as montoIngresadoSchema }
```

- [ ] **Step 2: Fábrica de XML de prueba**

`packages/shared/src/factura/construir-xml-prueba.ts`:
```ts
/**
 * Construye XML UBL 2.1 con la forma de una factura electrónica de SUNAT, para tests y para el modo
 * demostración de la landing. No es un XML válido ante SUNAT (no está firmado de verdad).
 */
export type CuotaPrueba = { id: string; monto: string; vence: string }

export type OpcionesXmlPrueba = {
  raiz?: 'Invoice' | 'CreditNote' | 'ApplicationResponse'
  /** Prefijos de espacio de nombres. `''` produce elementos sin prefijo. */
  prefijos?: { cbc: string; cac: string }
  tipoComprobante?: string
  serieNumero?: string
  fechaEmision?: string
  moneda?: string
  rucEmisor?: string
  razonSocialEmisor?: string
  rucReceptor?: string
  razonSocialReceptor?: string | null
  total?: string
  formaPago?: 'Contado' | 'Credito' | null
  montoNetoPendiente?: string | null
  cuotas?: CuotaPrueba[]
  detraccion?: { porcentaje: string; monto: string } | null
  firmada?: boolean
  /** Emite el RUC por la ruta legada PartyTaxScheme/CompanyID en vez de PartyIdentification/ID. */
  rutaRucLegada?: boolean
  bom?: boolean
  codificacionDeclarada?: string
  finalesDeLineaWindows?: boolean
  /** Elementos a omitir, para probar datos obligatorios ausentes. */
  omitir?: Array<'ID' | 'IssueDate' | 'DocumentCurrencyCode' | 'InvoiceTypeCode' | 'PayableAmount'>
}

export const XML_PRUEBA_POR_DEFECTO = {
  raiz: 'Invoice',
  prefijos: { cbc: 'cbc', cac: 'cac' },
  tipoComprobante: '01',
  serieNumero: 'F001-123',
  fechaEmision: '2026-09-01',
  moneda: 'PEN',
  rucEmisor: '20100070970',
  razonSocialEmisor: 'PROVEEDOR EJEMPLO S.A.C.',
  rucReceptor: '20131312955',
  razonSocialReceptor: 'SERVICIOS ENERGETICOS AMBIENTALES S.A.',
  total: '11800.00',
  formaPago: 'Credito',
  montoNetoPendiente: '10620.00',
  cuotas: [{ id: 'Cuota001', monto: '10620.00', vence: '2026-11-30' }],
  detraccion: { porcentaje: '10', monto: '1180.00' },
  firmada: true,
  rutaRucLegada: false,
  bom: false,
  codificacionDeclarada: 'UTF-8',
  finalesDeLineaWindows: false,
  omitir: [],
} as const satisfies Required<OpcionesXmlPrueba>

export function construirXmlFactura(opciones: OpcionesXmlPrueba = {}): string {
  const o = { ...XML_PRUEBA_POR_DEFECTO, ...opciones }
  const cbc = (t: string) => (o.prefijos.cbc ? `${o.prefijos.cbc}:${t}` : t)
  const cac = (t: string) => (o.prefijos.cac ? `${o.prefijos.cac}:${t}` : t)
  const el = (nombre: string, contenido: string, atributos = ''): string =>
    `<${nombre}${atributos}>${contenido}</${nombre}>`
  const omitido = (nombre: (typeof o.omitir)[number]) => o.omitir.includes(nombre)
  const monto = (nombre: string, valor: string) => el(cbc(nombre), valor, ` currencyID="${o.moneda}"`)

  const parte = (rol: 'AccountingSupplierParty' | 'AccountingCustomerParty', ruc: string, razon: string | null) =>
    el(
      cac(rol),
      el(
        cac('Party'),
        o.rutaRucLegada
          ? el(
              cac('PartyTaxScheme'),
              (razon === null ? '' : el(cbc('RegistrationName'), razon)) + el(cbc('CompanyID'), ruc, ' schemeID="6"'),
            )
          : el(cac('PartyIdentification'), el(cbc('ID'), ruc, ' schemeID="6"')) +
              (razon === null ? '' : el(cac('PartyLegalEntity'), el(cbc('RegistrationName'), razon))),
      ),
    )

  const terminosPago: string[] = []
  if (o.detraccion) {
    terminosPago.push(
      el(
        cac('PaymentTerms'),
        el(cbc('ID'), 'Detraccion') +
          el(cbc('PaymentMeansID'), '001') +
          el(cbc('PaymentPercent'), o.detraccion.porcentaje) +
          monto('Amount', o.detraccion.monto),
      ),
    )
  }
  if (o.formaPago) {
    terminosPago.push(
      el(
        cac('PaymentTerms'),
        el(cbc('ID'), 'FormaPago') +
          el(cbc('PaymentMeansID'), o.formaPago) +
          (o.formaPago === 'Credito' && o.montoNetoPendiente !== null ? monto('Amount', o.montoNetoPendiente) : ''),
      ),
    )
  }
  for (const c of o.cuotas) {
    terminosPago.push(
      el(
        cac('PaymentTerms'),
        el(cbc('ID'), 'FormaPago') +
          el(cbc('PaymentMeansID'), c.id) +
          monto('Amount', c.monto) +
          el(cbc('PaymentDueDate'), c.vence),
      ),
    )
  }

  const firma = o.firmada
    ? el(
        'ext:UBLExtensions',
        el('ext:UBLExtension', el('ext:ExtensionContent', el('ds:Signature', el('ds:SignatureValue', 'ZmlybWE='), ' Id="SignSUNAT"'))),
      )
    : ''

  const tipoTag = o.raiz === 'CreditNote' ? 'CreditNoteTypeCode' : 'InvoiceTypeCode'
  const cuerpo = [
    firma,
    el(cbc('UBLVersionID'), '2.1'),
    el(cbc('CustomizationID'), '2.0'),
    omitido('ID') ? '' : el(cbc('ID'), o.serieNumero),
    omitido('IssueDate') ? '' : el(cbc('IssueDate'), o.fechaEmision),
    omitido('InvoiceTypeCode') ? '' : el(cbc(tipoTag), o.tipoComprobante, ' listID="0101"'),
    omitido('DocumentCurrencyCode') ? '' : el(cbc('DocumentCurrencyCode'), o.moneda),
    parte('AccountingSupplierParty', o.rucEmisor, o.razonSocialEmisor),
    parte('AccountingCustomerParty', o.rucReceptor, o.razonSocialReceptor),
    ...terminosPago,
    el(
      cac('LegalMonetaryTotal'),
      monto('TaxInclusiveAmount', o.total) + (omitido('PayableAmount') ? '' : monto('PayableAmount', o.total)),
    ),
  ].join('\n  ')

  const ns = [
    `xmlns="urn:oasis:names:specification:ubl:schema:xsd:${o.raiz}-2"`,
    'xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"',
    'xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"',
    'xmlns:ds="http://www.w3.org/2000/09/xmldsig#"',
    'xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"',
  ]
  for (const p of [o.prefijos.cbc, o.prefijos.cac]) {
    if (p && p !== 'cbc' && p !== 'cac') ns.push(`xmlns:${p}="urn:ejemplo:${p}"`)
  }

  let xml = `<?xml version="1.0" encoding="${o.codificacionDeclarada}"?>\n<${o.raiz} ${ns.join(' ')}>\n  ${cuerpo}\n</${o.raiz}>\n`
  if (o.finalesDeLineaWindows) xml = xml.replace(/\n/g, '\r\n')
  if (o.bom) xml = `﻿${xml}`
  return xml
}

/** Constancia de recepción (CDR) de SUNAT: no es una factura. */
export function construirXmlCdr(): string {
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

Crear `packages/shared/test/fixtures/factura-credito-pen.xml` con el resultado de `construirXmlFactura()` sin opciones. Se genera una vez con este comando y se commitea, para que una persona pueda abrirlo y ver la forma:

Run: `pnpm --filter @anticipate/shared exec tsx -e "import('./src/factura/construir-xml-prueba.ts').then(m => process.stdout.write(m.construirXmlFactura()))" > packages/shared/test/fixtures/factura-credito-pen.xml`
(Si `tsx` no está instalado: `pnpm add -Dw tsx` y agregarlo al catálogo. Es solo para este paso y para scripts de desarrollo.)

- [ ] **Step 3: Escribir los tests del lector que fallan**

`packages/shared/src/factura/lector-ubl.test.ts`:
```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { construirXmlCdr, construirXmlFactura } from './construir-xml-prueba.js'
import { decodificarXml, leerFacturaUbl } from './lector-ubl.js'

function leerOk(xml: string) {
  const r = leerFacturaUbl(xml)
  if (!r.ok) throw new Error(`Se esperaba lectura correcta: ${r.problema.codigo}`)
  return r.factura
}

function leerError(xml: string) {
  const r = leerFacturaUbl(xml)
  if (r.ok) throw new Error('Se esperaba un problema')
  return r.problema
}

describe('leerFacturaUbl · factura al crédito', () => {
  const f = leerOk(construirXmlFactura())

  it('lee identificación, fechas y moneda', () => {
    expect(f.tipoComprobante).toBe('01')
    expect(f.serieNumero).toBe('F001-123')
    expect(f.fechaEmision).toBe('2026-09-01')
    expect(f.moneda).toBe('PEN')
  })

  it('lee emisor y receptor', () => {
    expect(f.rucEmisor).toBe('20100070970')
    expect(f.razonSocialEmisor).toBe('PROVEEDOR EJEMPLO S.A.C.')
    expect(f.rucReceptor).toBe('20131312955')
    expect(f.razonSocialReceptor).toBe('SERVICIOS ENERGETICOS AMBIENTALES S.A.')
  })

  it('lee total, forma de pago, neto pendiente, cuotas y detracción', () => {
    expect(f.total).toBe('11800.00')
    expect(f.formaPago).toBe('CREDITO')
    expect(f.montoNetoPendiente).toBe('10620.00')
    expect(f.cuotas).toEqual([{ id: 'Cuota001', monto: '10620.00', vence: '2026-11-30' }])
    expect(f.detraccion).toEqual({ porcentaje: 10, monto: '1180.00' })
    expect(f.firmada).toBe(true)
  })

  it('lee el fixture estático igual que el XML generado', () => {
    const estatico = readFileSync(new URL('../../test/fixtures/factura-credito-pen.xml', import.meta.url), 'utf8')
    expect(leerOk(estatico)).toEqual(f)
  })
})

describe('leerFacturaUbl · variantes', () => {
  it('factura al contado: sin neto pendiente ni cuotas', () => {
    const f = leerOk(construirXmlFactura({ formaPago: 'Contado', montoNetoPendiente: null, cuotas: [] }))
    expect(f.formaPago).toBe('CONTADO')
    expect(f.montoNetoPendiente).toBeNull()
    expect(f.cuotas).toEqual([])
  })

  it('sin bloque de forma de pago: formaPago null', () => {
    const f = leerOk(construirXmlFactura({ formaPago: null, cuotas: [] }))
    expect(f.formaPago).toBeNull()
  })

  it('varias cuotas', () => {
    const cuotas = [
      { id: 'Cuota001', monto: '5000.00', vence: '2026-10-30' },
      { id: 'Cuota002', monto: '5620.00', vence: '2026-11-30' },
    ]
    expect(leerOk(construirXmlFactura({ cuotas })).cuotas).toEqual(cuotas)
  })

  it('sin detracción ni razón social del receptor', () => {
    const f = leerOk(construirXmlFactura({ detraccion: null, razonSocialReceptor: null }))
    expect(f.detraccion).toBeNull()
    expect(f.razonSocialReceptor).toBeNull()
  })

  it('normaliza montos sin dos decimales', () => {
    const f = leerOk(construirXmlFactura({ total: '11800.5', montoNetoPendiente: '10620' }))
    expect(f.total).toBe('11800.50')
    expect(f.montoNetoPendiente).toBe('10620.00')
  })

  it('no firmada', () => {
    expect(leerOk(construirXmlFactura({ firmada: false })).firmada).toBe(false)
  })

  it('lee una boleta (tipo 03) sin rechazarla; la regla de tipo decide después', () => {
    expect(leerOk(construirXmlFactura({ tipoComprobante: '03' })).tipoComprobante).toBe('03')
  })
})

describe('leerFacturaUbl · robustez de formato', () => {
  it('tolera BOM y finales de línea de Windows', () => {
    const f = leerOk(construirXmlFactura({ bom: true, finalesDeLineaWindows: true }))
    expect(f.serieNumero).toBe('F001-123')
  })

  it('tolera elementos sin prefijo de espacio de nombres', () => {
    const f = leerOk(construirXmlFactura({ prefijos: { cbc: '', cac: '' } }))
    expect(f.rucEmisor).toBe('20100070970')
  })

  it('tolera prefijos distintos de cbc/cac', () => {
    const f = leerOk(construirXmlFactura({ prefijos: { cbc: 'n1', cac: 'n2' } }))
    expect(f.montoNetoPendiente).toBe('10620.00')
  })

  it('tolera la ruta legada del RUC (PartyTaxScheme/CompanyID)', () => {
    const f = leerOk(construirXmlFactura({ rutaRucLegada: true }))
    expect(f.rucEmisor).toBe('20100070970')
    expect(f.rucReceptor).toBe('20131312955')
    expect(f.razonSocialEmisor).toBe('PROVEEDOR EJEMPLO S.A.C.')
  })
})

describe('leerFacturaUbl · errores', () => {
  it('XML malformado', () => {
    expect(leerError('<Invoice><cbc:ID>F001-1</Invoice>').codigo).toBe('XML_ILEGIBLE')
  })

  it('texto que no es XML', () => {
    expect(leerError('%PDF-1.7 ...').codigo).toBe('XML_ILEGIBLE')
  })

  it('CDR de SUNAT', () => {
    const p = leerError(construirXmlCdr())
    expect(p.codigo).toBe('XML_NO_ES_FACTURA')
    expect(p.mensaje).toContain('constancia de recepción')
  })

  it('nota de crédito', () => {
    const p = leerError(construirXmlFactura({ raiz: 'CreditNote' }))
    expect(p.codigo).toBe('XML_NO_ES_FACTURA')
    expect(p.mensaje).toContain('nota de crédito')
  })

  it.each([
    ['ID', 'serie y número'],
    ['IssueDate', 'fecha de emisión'],
    ['InvoiceTypeCode', 'tipo de comprobante'],
    ['DocumentCurrencyCode', 'moneda'],
    ['PayableAmount', 'total'],
  ] as const)('falta %s', (elemento, nombre) => {
    const p = leerError(construirXmlFactura({ omitir: [elemento] }))
    expect(p.codigo).toBe('XML_SIN_DATO_OBLIGATORIO')
    expect(p.mensaje).toContain(nombre)
  })

  it('no resuelve entidades externas', () => {
    const xml = construirXmlFactura().replace(
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>',
    ).replace('F001-123', '&xxe;')
    const r = leerFacturaUbl(xml)
    if (r.ok) expect(r.factura.serieNumero).not.toContain('root:')
  })
})

describe('decodificarXml', () => {
  it('decodifica UTF-8 con BOM', () => {
    const bytes = new TextEncoder().encode('﻿<?xml version="1.0" encoding="UTF-8"?><a>Ñ</a>')
    expect(decodificarXml(bytes)).toContain('<a>Ñ</a>')
  })

  it('respeta la codificación declarada (ISO-8859-1)', () => {
    const texto = '<?xml version="1.0" encoding="ISO-8859-1"?><a>Ñ</a>'
    const bytes = Uint8Array.from(texto, (ch) => ch.charCodeAt(0))
    expect(decodificarXml(bytes)).toContain('<a>Ñ</a>')
  })
})
```

- [ ] **Step 4: Correr y verificar que fallan**

Run: `pnpm --filter @anticipate/shared test -- factura`
Expected: FAIL, "Cannot find module './lector-ubl.js'".

- [ ] **Step 5: Implementar el lector**

`packages/shared/src/factura/lector-ubl.ts`:
```ts
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { normalizarMonto } from '../dinero/index.js'
import { esFechaIso } from '../fechas/index.js'
import { type Problema, crearProblema } from '../errores/index.js'
import { type FormaPago } from './codigos.js'
import { type Cuota, type FacturaLeida, facturaLeidaSchema } from './factura-leida.js'

export type ResultadoLectura = { ok: true; factura: FacturaLeida } | { ok: false; problema: Problema }

const TEXTO = '#texto'

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: TEXTO,
  removeNSPrefix: true,
  processEntities: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
})

type Nodo = string | { [clave: string]: unknown } | undefined

function texto(nodo: unknown): string | undefined {
  if (typeof nodo === 'string') return nodo
  if (nodo && typeof nodo === 'object' && TEXTO in nodo) {
    const t = (nodo as Record<string, unknown>)[TEXTO]
    return typeof t === 'string' ? t : undefined
  }
  return undefined
}

function lista<T>(valor: T | T[] | undefined): T[] {
  if (valor === undefined) return []
  return Array.isArray(valor) ? valor : [valor]
}

function ruta(raiz: unknown, ...pasos: string[]): unknown {
  let actual: unknown = raiz
  for (const paso of pasos) {
    if (!actual || typeof actual !== 'object') return undefined
    actual = lista((actual as Record<string, unknown>)[paso])[0]
  }
  return actual
}

const NOMBRE_RAIZ: Record<string, string> = {
  ApplicationResponse: 'constancia de recepción (CDR)',
  CreditNote: 'nota de crédito',
  DebitNote: 'nota de débito',
  SummaryDocuments: 'resumen diario',
  VoidedDocuments: 'comunicación de baja',
}

/** Decodifica los bytes de un XML respetando su BOM o la codificación declarada en el prólogo. */
export function decodificarXml(bytes: Uint8Array): string {
  const cabecera = new TextDecoder('latin1').decode(bytes.subarray(0, 200))
  const declarada = /encoding=["']([\w-]+)["']/i.exec(cabecera)?.[1]
  const tieneBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  const codificacion = tieneBom ? 'utf-8' : (declarada ?? 'utf-8')
  let decodificador: TextDecoder
  try {
    decodificador = new TextDecoder(codificacion)
  } catch {
    decodificador = new TextDecoder('utf-8')
  }
  return decodificador.decode(bytes).replace(/^﻿/, '')
}

function fallo(problema: Problema): ResultadoLectura {
  return { ok: false, problema }
}

/** Ruta vigente (PartyIdentification/ID) con fallback a la legada (PartyTaxScheme/CompanyID). */
function rucDe(inv: Record<string, unknown>, rol: string): string | undefined {
  return (
    texto(ruta(inv, rol, 'Party', 'PartyIdentification', 'ID')) ??
    texto(ruta(inv, rol, 'Party', 'PartyTaxScheme', 'CompanyID'))
  )
}

function razonSocialDe(inv: Record<string, unknown>, rol: string): string | undefined {
  return (
    texto(ruta(inv, rol, 'Party', 'PartyLegalEntity', 'RegistrationName')) ??
    texto(ruta(inv, rol, 'Party', 'PartyTaxScheme', 'RegistrationName'))
  )
}

export function leerFacturaUbl(xmlCrudo: string): ResultadoLectura {
  const xml = xmlCrudo.replace(/^﻿/, '')
  if (!xml.trimStart().startsWith('<') || XMLValidator.validate(xml) !== true) {
    return fallo(crearProblema('XML_ILEGIBLE'))
  }

  let documento: Record<string, unknown>
  try {
    documento = parser.parse(xml) as Record<string, unknown>
  } catch {
    return fallo(crearProblema('XML_ILEGIBLE'))
  }

  const nombreRaiz = Object.keys(documento).find((k) => k !== '?xml')
  if (nombreRaiz !== 'Invoice') {
    const tipo = (nombreRaiz && NOMBRE_RAIZ[nombreRaiz]) ?? nombreRaiz ?? 'desconocido'
    return fallo(crearProblema('XML_NO_ES_FACTURA', { datos: { tipo } }))
  }
  const inv = documento.Invoice as Record<string, unknown>

  const obligatorio = (nombre: string, valor: string | undefined): string | ResultadoLectura =>
    valor && valor.length > 0 ? valor : fallo(crearProblema('XML_SIN_DATO_OBLIGATORIO', { datos: { dato: nombre } }))

  const serieNumero = obligatorio('serie y número', texto(inv.ID))
  if (typeof serieNumero !== 'string') return serieNumero
  const fechaEmision = obligatorio('fecha de emisión', texto(inv.IssueDate))
  if (typeof fechaEmision !== 'string') return fechaEmision
  const tipoComprobante = obligatorio('tipo de comprobante', texto(inv.InvoiceTypeCode))
  if (typeof tipoComprobante !== 'string') return tipoComprobante
  const moneda = obligatorio('moneda', texto(inv.DocumentCurrencyCode))
  if (typeof moneda !== 'string') return moneda
  const rucEmisor = obligatorio('RUC del emisor', rucDe(inv, 'AccountingSupplierParty'))
  if (typeof rucEmisor !== 'string') return rucEmisor
  const rucReceptor = obligatorio('RUC del receptor', rucDe(inv, 'AccountingCustomerParty'))
  if (typeof rucReceptor !== 'string') return rucReceptor
  const totalCrudo = obligatorio('total', texto(ruta(inv, 'LegalMonetaryTotal', 'PayableAmount')))
  if (typeof totalCrudo !== 'string') return totalCrudo
  const total = normalizarMonto(totalCrudo)
  if (total === null) return fallo(crearProblema('XML_SIN_DATO_OBLIGATORIO', { datos: { dato: 'total' } }))
  if (!esFechaIso(fechaEmision)) {
    return fallo(crearProblema('XML_SIN_DATO_OBLIGATORIO', { datos: { dato: 'fecha de emisión' } }))
  }

  let formaPago: FormaPago | null = null
  let montoNetoPendiente: string | null = null
  const cuotas: Cuota[] = []
  let detraccion: FacturaLeida['detraccion'] = null

  for (const termino of lista(inv.PaymentTerms as Nodo | Nodo[])) {
    const id = texto(ruta(termino, 'ID'))
    const medio = texto(ruta(termino, 'PaymentMeansID')) ?? ''
    const monto = normalizarMonto(texto(ruta(termino, 'Amount')) ?? '')
    if (id === 'FormaPago') {
      if (medio === 'Contado') formaPago = 'CONTADO'
      else if (medio === 'Credito') {
        formaPago = 'CREDITO'
        montoNetoPendiente = monto
      } else if (/^Cuota\d+$/i.test(medio)) {
        const vence = texto(ruta(termino, 'PaymentDueDate')) ?? ''
        if (monto !== null && esFechaIso(vence)) cuotas.push({ id: medio, monto, vence })
      }
    } else if (id === 'Detraccion') {
      const porcentaje = Number(texto(ruta(termino, 'PaymentPercent')) ?? Number.NaN)
      if (monto !== null && Number.isFinite(porcentaje)) detraccion = { porcentaje, monto }
    }
  }

  const factura: FacturaLeida = {
    tipoComprobante,
    serieNumero,
    fechaEmision,
    moneda,
    rucEmisor,
    razonSocialEmisor: razonSocialDe(inv, 'AccountingSupplierParty') ?? '',
    rucReceptor,
    razonSocialReceptor: razonSocialDe(inv, 'AccountingCustomerParty') ?? null,
    total,
    formaPago,
    montoNetoPendiente,
    cuotas,
    detraccion,
    firmada: ruta(inv, 'UBLExtensions', 'UBLExtension', 'ExtensionContent', 'Signature') !== undefined,
  }

  const validada = facturaLeidaSchema.safeParse(factura)
  return validada.success ? { ok: true, factura: validada.data } : fallo(crearProblema('XML_ILEGIBLE'))
}
```

`packages/shared/src/factura/index.ts` (las reglas se agregan en la Tarea 6):
```ts
export { FORMAS_PAGO, type FormaPago, NOMBRE_TIPO_COMPROBANTE, TIPO_COMPROBANTE, type TipoComprobante } from './codigos.js'
export {
  type CuotaPrueba,
  construirXmlCdr,
  construirXmlFactura,
  type OpcionesXmlPrueba,
  XML_PRUEBA_POR_DEFECTO,
} from './construir-xml-prueba.js'
export { type Cuota, cuotaSchema, type FacturaLeida, facturaLeidaSchema } from './factura-leida.js'
export { decodificarXml, leerFacturaUbl, type ResultadoLectura } from './lector-ubl.js'
```

Agregar a `packages/shared/src/index.ts`:
```ts
export * from './factura/index.js'
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

### Task 6: Dominio `factura` · reglas de validación parametrizadas

**Files:**
- Create: `packages/shared/src/factura/reglas.ts`
- Test: `packages/shared/src/factura/reglas.test.ts`
- Modify: `packages/shared/src/factura/index.ts`

**Interfaces:**
- Consumes: `FacturaLeida`, `leerFacturaUbl`, `construirXmlFactura` (Tarea 5); `Monto`, `sumarMontos`, `porcentajeDe`, `compararMontos`, `normalizarMonto` (Tarea 4); `diasEntre` (Tarea 4); `crearProblema` (Tarea 2).
- Produces: `ContextoValidacion`, `ReglaFactura`, `REGLAS_POR_FACTURA`, `validarFacturas(facturas, ctx): ResultadoValidacion`, `validarMontoSolicitado(monto, resultado): Problema | null`. La landing los corre en el navegador y la API en el servidor con el mismo contexto (D24).

**Diseño.** Cada regla es una función pura `(factura, contexto) => Problema[]`. El contexto trae todo lo que varía por pagador o por configuración; ninguna regla contiene un valor de negocio. `rucProveedor` es opcional porque en la landing las facturas se leen antes de que el proveedor confirme su RUC (D22): si no viene, la regla del emisor se omite y la del conjunto exige que todas las facturas compartan emisor.

- [ ] **Step 1: Escribir los tests que fallan**

`packages/shared/src/factura/reglas.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { construirXmlFactura, type OpcionesXmlPrueba } from './construir-xml-prueba.js'
import { leerFacturaUbl } from './lector-ubl.js'
import { type ContextoValidacion, validarFacturas, validarMontoSolicitado } from './reglas.js'

function factura(opciones: OpcionesXmlPrueba = {}) {
  const r = leerFacturaUbl(construirXmlFactura(opciones))
  if (!r.ok) throw new Error(r.problema.codigo)
  return r.factura
}

const ctx: ContextoValidacion = {
  rucPagador: '20131312955',
  nombrePagador: 'SEA',
  rucProveedor: '20100070970',
  porcentajeAdelanto: 80,
  plazoMinimoDias: 15,
  maxFacturas: 10,
  monedasPermitidas: ['PEN', 'USD'],
  hoy: '2026-09-23',
}

const codigos = (r: ReturnType<typeof validarFacturas>) => r.problemas.map((p) => p.codigo)

describe('validarFacturas · caso válido', () => {
  it('acepta una factura al crédito al pagador, del proveedor, con cuota futura', () => {
    const r = validarFacturas([factura()], ctx)
    expect(r.problemas).toEqual([])
    expect(r.facturasValidas).toHaveLength(1)
    expect(r.moneda).toBe('PEN')
    expect(r.netoPendienteTotal).toBe('10620.00')
    expect(r.montoMaximo).toBe('8496.00')
  })

  it('suma el neto pendiente de varias facturas y calcula el máximo con el porcentaje del contexto', () => {
    const r = validarFacturas(
      [factura(), factura({ serieNumero: 'F001-124', montoNetoPendiente: '1000.00' })],
      { ...ctx, porcentajeAdelanto: 50 },
    )
    expect(r.netoPendienteTotal).toBe('11620.00')
    expect(r.montoMaximo).toBe('5810.00')
  })
})

describe('validarFacturas · reglas por factura', () => {
  it('rechaza una boleta', () => {
    const r = validarFacturas([factura({ tipoComprobante: '03' })], ctx)
    expect(codigos(r)).toEqual(['TIPO_COMPROBANTE_NO_PERMITIDO'])
    expect(r.problemas[0]?.factura).toBe('F001-123')
    expect(r.problemas[0]?.mensaje).toContain('boleta de venta')
  })

  it('rechaza una factura emitida a otro receptor', () => {
    const r = validarFacturas([factura({ rucReceptor: '20100070970' })], ctx)
    expect(codigos(r)).toEqual(['RECEPTOR_NO_ES_PAGADOR'])
    expect(r.problemas[0]?.mensaje).toContain('SEA')
  })

  it('rechaza una factura de otro emisor cuando el contexto trae el RUC del proveedor', () => {
    const r = validarFacturas([factura({ rucEmisor: '10467286736' })], ctx)
    expect(codigos(r)).toEqual(['EMISOR_NO_ES_PROVEEDOR'])
  })

  it('no aplica la regla del emisor si el contexto no trae el RUC del proveedor', () => {
    const { rucProveedor: _omitido, ...sinProveedor } = ctx
    const r = validarFacturas([factura({ rucEmisor: '10467286736' })], sinProveedor)
    expect(codigos(r)).toEqual([])
  })

  it('rechaza una factura al contado', () => {
    const r = validarFacturas([factura({ formaPago: 'Contado', montoNetoPendiente: null, cuotas: [] })], ctx)
    expect(codigos(r)).toEqual(['FACTURA_AL_CONTADO'])
  })

  it('rechaza una factura sin forma de pago o sin neto pendiente', () => {
    expect(codigos(validarFacturas([factura({ formaPago: null, cuotas: [] })], ctx))).toEqual(['SIN_MONTO_PENDIENTE'])
    expect(codigos(validarFacturas([factura({ montoNetoPendiente: '0.00' })], ctx))).toEqual(['SIN_MONTO_PENDIENTE'])
  })

  it('rechaza una moneda que el pagador no acepta', () => {
    const r = validarFacturas([factura({ moneda: 'EUR' })], { ...ctx, monedasPermitidas: ['PEN'] })
    expect(codigos(r)).toEqual(['MONEDA_NO_PERMITIDA'])
  })

  it('señala la cuota vencida aunque otra sea futura', () => {
    const r = validarFacturas(
      [
        factura({
          cuotas: [
            { id: 'Cuota001', monto: '5000.00', vence: '2026-09-01' },
            { id: 'Cuota002', monto: '5620.00', vence: '2026-12-01' },
          ],
        }),
      ],
      ctx,
    )
    expect(codigos(r)).toEqual(['CUOTA_VENCIDA'])
    expect(r.problemas[0]?.mensaje).toContain('Cuota001')
  })

  it('exige el plazo mínimo del contexto', () => {
    const r = validarFacturas([factura({ cuotas: [{ id: 'Cuota001', monto: '10620.00', vence: '2026-10-01' }] })], ctx)
    expect(codigos(r)).toEqual(['PLAZO_INSUFICIENTE'])
    const ok = validarFacturas([factura({ cuotas: [{ id: 'Cuota001', monto: '10620.00', vence: '2026-10-08' }] })], ctx)
    expect(codigos(ok)).toEqual([])
  })

  it('una factura al crédito sin cuotas es un dato obligatorio ausente', () => {
    expect(codigos(validarFacturas([factura({ cuotas: [] })], ctx))).toEqual(['XML_SIN_DATO_OBLIGATORIO'])
  })
})

describe('validarFacturas · reglas del conjunto', () => {
  it('rechaza una solicitud sin facturas', () => {
    expect(codigos(validarFacturas([], ctx))).toEqual(['SIN_FACTURAS'])
  })

  it('rechaza más facturas que el máximo del contexto', () => {
    const tres = ['F001-1', 'F001-2', 'F001-3'].map((serieNumero) => factura({ serieNumero }))
    expect(codigos(validarFacturas(tres, { ...ctx, maxFacturas: 2 }))).toEqual(['DEMASIADAS_FACTURAS'])
  })

  it('rechaza la misma factura repetida, ignorando mayúsculas y espacios', () => {
    const r = validarFacturas([factura(), factura({ serieNumero: ' f001-123 ' })], ctx)
    expect(codigos(r)).toEqual(['FACTURA_REPETIDA'])
  })

  it('rechaza emisores distintos cuando no hay RUC del proveedor en el contexto', () => {
    const { rucProveedor: _omitido, ...sinProveedor } = ctx
    const r = validarFacturas([factura(), factura({ serieNumero: 'F001-9', rucEmisor: '10467286736' })], sinProveedor)
    expect(codigos(r)).toEqual(['EMISORES_DISTINTOS'])
  })

  it('rechaza monedas distintas y no calcula máximo', () => {
    const r = validarFacturas([factura(), factura({ serieNumero: 'F001-9', moneda: 'USD' })], ctx)
    expect(codigos(r)).toEqual(['MONEDAS_DISTINTAS'])
    expect(r.moneda).toBeNull()
    expect(r.montoMaximo).toBe('0.00')
  })

  it('las facturas con problemas no cuentan para el máximo', () => {
    const r = validarFacturas([factura(), factura({ serieNumero: 'F001-9', formaPago: 'Contado', cuotas: [] })], ctx)
    expect(r.facturasValidas).toHaveLength(1)
    expect(r.montoMaximo).toBe('8496.00')
  })
})

describe('validarMontoSolicitado', () => {
  const resultado = validarFacturas([factura()], ctx)

  it('acepta un monto hasta el máximo', () => {
    expect(validarMontoSolicitado('8496.00', resultado)).toBeNull()
    expect(validarMontoSolicitado('100.00', resultado)).toBeNull()
  })

  it('rechaza un monto mayor al máximo con el máximo y la moneda en el mensaje', () => {
    const p = validarMontoSolicitado('8496.01', resultado)
    expect(p?.codigo).toBe('MONTO_SUPERA_MAXIMO')
    expect(p?.mensaje).toBe('El monto solicitado supera el máximo de 8496.00 PEN.')
  })

  it('rechaza montos inválidos', () => {
    expect(validarMontoSolicitado('abc', resultado)?.codigo).toBe('MONTO_INVALIDO')
    expect(validarMontoSolicitado('0.00', resultado)?.codigo).toBe('MONTO_INVALIDO')
  })
})
```

- [ ] **Step 2: Correr y verificar que fallan**

Run: `pnpm --filter @anticipate/shared test -- reglas`
Expected: FAIL, "Cannot find module './reglas.js'".

- [ ] **Step 3: Implementar**

`packages/shared/src/factura/reglas.ts`:
```ts
import { type Monto, compararMontos, normalizarMonto, porcentajeDe, sumarMontos, aCentimos } from '../dinero/index.js'
import { type Problema, crearProblema } from '../errores/index.js'
import { type FechaIso, diasEntre } from '../fechas/index.js'
import { NOMBRE_TIPO_COMPROBANTE, TIPO_COMPROBANTE } from './codigos.js'
import type { FacturaLeida } from './factura-leida.js'

/** Todo lo que varía por pagador o por configuración. Ninguna regla guarda valores propios. */
export type ContextoValidacion = {
  rucPagador: string
  nombrePagador: string
  /** Opcional: en la landing las facturas se leen antes de conocer el RUC del proveedor. */
  rucProveedor?: string
  /** 0 a 100. */
  porcentajeAdelanto: number
  plazoMinimoDias: number
  maxFacturas: number
  monedasPermitidas: readonly string[]
  hoy: FechaIso
}

export type ReglaFactura = (factura: FacturaLeida, ctx: ContextoValidacion) => Problema[]

const conFactura = (f: FacturaLeida, problema: Problema): Problema => ({ ...problema, factura: f.serieNumero })

export const reglaTipoComprobante: ReglaFactura = (f) =>
  f.tipoComprobante === TIPO_COMPROBANTE.FACTURA
    ? []
    : [
        conFactura(
          f,
          crearProblema('TIPO_COMPROBANTE_NO_PERMITIDO', {
            datos: { tipo: NOMBRE_TIPO_COMPROBANTE[f.tipoComprobante] ?? f.tipoComprobante },
          }),
        ),
      ]

export const reglaReceptorEsPagador: ReglaFactura = (f, ctx) =>
  f.rucReceptor === ctx.rucPagador
    ? []
    : [conFactura(f, crearProblema('RECEPTOR_NO_ES_PAGADOR', { datos: { pagador: ctx.nombrePagador } }))]

export const reglaEmisorEsProveedor: ReglaFactura = (f, ctx) =>
  ctx.rucProveedor === undefined || f.rucEmisor === ctx.rucProveedor
    ? []
    : [conFactura(f, crearProblema('EMISOR_NO_ES_PROVEEDOR', { datos: { emisor: f.rucEmisor } }))]

export const reglaAlCreditoConNetoPendiente: ReglaFactura = (f) => {
  if (f.formaPago === 'CONTADO') return [conFactura(f, crearProblema('FACTURA_AL_CONTADO'))]
  if (f.formaPago !== 'CREDITO' || f.montoNetoPendiente === null || aCentimos(f.montoNetoPendiente) === 0n) {
    return [conFactura(f, crearProblema('SIN_MONTO_PENDIENTE'))]
  }
  return []
}

export const reglaMonedaPermitida: ReglaFactura = (f, ctx) =>
  ctx.monedasPermitidas.includes(f.moneda)
    ? []
    : [conFactura(f, crearProblema('MONEDA_NO_PERMITIDA', { datos: { moneda: f.moneda } }))]

export const reglaCuotasVigentes: ReglaFactura = (f, ctx) => {
  if (f.formaPago !== 'CREDITO') return []
  if (f.cuotas.length === 0) {
    return [conFactura(f, crearProblema('XML_SIN_DATO_OBLIGATORIO', { datos: { dato: 'fechas de vencimiento (cuotas)' } }))]
  }
  const problemas: Problema[] = []
  for (const cuota of f.cuotas) {
    const dias = diasEntre(ctx.hoy, cuota.vence)
    if (dias < 0) {
      problemas.push(conFactura(f, crearProblema('CUOTA_VENCIDA', { datos: { cuota: cuota.id, fecha: cuota.vence } })))
    } else if (dias < ctx.plazoMinimoDias) {
      problemas.push(
        conFactura(f, crearProblema('PLAZO_INSUFICIENTE', { datos: { cuota: cuota.id, dias: ctx.plazoMinimoDias } })),
      )
    }
  }
  return problemas
}

/** Orden de evaluación. Agregar una regla = agregar una función aquí y su test. */
export const REGLAS_POR_FACTURA: readonly ReglaFactura[] = [
  reglaTipoComprobante,
  reglaReceptorEsPagador,
  reglaEmisorEsProveedor,
  reglaAlCreditoConNetoPendiente,
  reglaMonedaPermitida,
  reglaCuotasVigentes,
]

export type ResultadoValidacion = {
  problemas: Problema[]
  facturasValidas: FacturaLeida[]
  /** Moneda común de las facturas válidas, o null si no hay o difieren. */
  moneda: string | null
  netoPendienteTotal: Monto
  /** Neto pendiente total × porcentaje de adelanto. "0.00" si no se puede calcular. */
  montoMaximo: Monto
}

const claveFactura = (f: FacturaLeida) => f.serieNumero.trim().toUpperCase()

export function validarFacturas(facturas: readonly FacturaLeida[], ctx: ContextoValidacion): ResultadoValidacion {
  const problemas: Problema[] = []
  const vacio: ResultadoValidacion = { problemas, facturasValidas: [], moneda: null, netoPendienteTotal: '0.00', montoMaximo: '0.00' }

  if (facturas.length === 0) {
    problemas.push(crearProblema('SIN_FACTURAS'))
    return vacio
  }
  if (facturas.length > ctx.maxFacturas) {
    problemas.push(crearProblema('DEMASIADAS_FACTURAS', { datos: { maximo: ctx.maxFacturas } }))
    return vacio
  }

  const vistas = new Set<string>()
  const candidatas: FacturaLeida[] = []
  for (const f of facturas) {
    const clave = claveFactura(f)
    if (vistas.has(clave)) {
      problemas.push(crearProblema('FACTURA_REPETIDA', { factura: f.serieNumero, datos: { factura: f.serieNumero } }))
      continue
    }
    vistas.add(clave)
    candidatas.push(f)
  }

  const facturasValidas = candidatas.filter((f) => {
    const propios = REGLAS_POR_FACTURA.flatMap((regla) => regla(f, ctx))
    problemas.push(...propios)
    return propios.length === 0
  })
  if (facturasValidas.length === 0) return { ...vacio, problemas }

  const emisores = new Set(facturasValidas.map((f) => f.rucEmisor))
  if (emisores.size > 1) problemas.push(crearProblema('EMISORES_DISTINTOS'))

  const monedas = new Set(facturasValidas.map((f) => f.moneda))
  if (monedas.size > 1) {
    problemas.push(crearProblema('MONEDAS_DISTINTAS'))
    return { ...vacio, problemas, facturasValidas }
  }

  const netoPendienteTotal = sumarMontos(...facturasValidas.map((f) => f.montoNetoPendiente ?? '0.00'))
  return {
    problemas,
    facturasValidas,
    moneda: facturasValidas[0]?.moneda ?? null,
    netoPendienteTotal,
    montoMaximo: porcentajeDe(netoPendienteTotal, ctx.porcentajeAdelanto),
  }
}

export function validarMontoSolicitado(monto: string, resultado: ResultadoValidacion): Problema | null {
  const normalizado = normalizarMonto(monto)
  if (normalizado === null || aCentimos(normalizado) === 0n) return crearProblema('MONTO_INVALIDO', { campo: 'montoSolicitado' })
  if (compararMontos(normalizado, resultado.montoMaximo) > 0) {
    return crearProblema('MONTO_SUPERA_MAXIMO', {
      campo: 'montoSolicitado',
      datos: { maximo: resultado.montoMaximo, moneda: resultado.moneda ?? '' },
    })
  }
  return null
}
```

Agregar a `packages/shared/src/factura/index.ts`:
```ts
export {
  type ContextoValidacion,
  REGLAS_POR_FACTURA,
  type ReglaFactura,
  type ResultadoValidacion,
  reglaAlCreditoConNetoPendiente,
  reglaCuotasVigentes,
  reglaEmisorEsProveedor,
  reglaMonedaPermitida,
  reglaReceptorEsPagador,
  reglaTipoComprobante,
  validarFacturas,
  validarMontoSolicitado,
} from './reglas.js'
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

### Task 7: Dominios `usuario` y `solicitud` · roles, estados, motivos y transiciones como datos

**Files:**
- Create: `packages/shared/src/usuario/roles.ts`, `packages/shared/src/usuario/index.ts`
- Create: `packages/shared/src/solicitud/estados.ts`, `packages/shared/src/solicitud/motivos.ts`, `packages/shared/src/solicitud/transiciones.ts`, `packages/shared/src/solicitud/index.ts`
- Test: `packages/shared/src/usuario/roles.test.ts`, `packages/shared/src/solicitud/transiciones.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces: `ROLES`, `Rol`, `rolAlcanza(rol, minimo)`, `rolSchema`; `ESTADOS_SOLICITUD`, `EstadoSolicitud`, `ESTADO_INICIAL`, `ESTADOS_TERMINALES`, `esEstadoTerminal`, `NOMBRE_ESTADO`, `estadoSolicitudSchema`; `MOTIVOS_CIERRE`, `MotivoCierre`, `MOTIVOS_POR_ESTADO`, `NOMBRE_MOTIVO`, `motivoSchema`; `GUARDAS`, `Guarda`, `Hechos`, `Transicion`, `TRANSICIONES`, `transicionesDesde(desde, rol)`, `transicionesDisponibles(desde, rol, hechos)`, `evaluarCambioEstado(cambio): ResultadoCambio`, `cambioEstadoSchema`. La API calcula los `Hechos` con Prisma (por ejemplo `documentosVigentes`), devuelve `transicionesDisponibles` como `accionesPermitidas` en cada respuesta de solicitud y vuelve a evaluar en el PATCH; el admin pinta solo esos botones.

- [ ] **Step 1: Escribir los tests que fallan**

`packages/shared/src/usuario/roles.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { rolAlcanza } from './roles.js'

describe('rolAlcanza', () => {
  it('ADMIN alcanza todo; GESTOR solo GESTOR', () => {
    expect(rolAlcanza('ADMIN', 'ADMIN')).toBe(true)
    expect(rolAlcanza('ADMIN', 'GESTOR')).toBe(true)
    expect(rolAlcanza('GESTOR', 'GESTOR')).toBe(true)
    expect(rolAlcanza('GESTOR', 'ADMIN')).toBe(false)
  })
})
```

`packages/shared/src/solicitud/transiciones.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { ESTADO_INICIAL, ESTADOS_SOLICITUD, ESTADOS_TERMINALES, esEstadoTerminal } from './estados.js'
import { MOTIVOS_POR_ESTADO } from './motivos.js'
import {
  TRANSICIONES,
  cambioEstadoSchema,
  evaluarCambioEstado,
  transicionesDesde,
  transicionesDisponibles,
} from './transiciones.js'

const salidas = (estado: string) => TRANSICIONES.filter((t) => t.desde === estado).map((t) => t.hacia)

describe('estructura de la máquina de estados', () => {
  it('no hay transiciones duplicadas', () => {
    const claves = TRANSICIONES.map((t) => `${t.desde}->${t.hacia}`)
    expect(new Set(claves).size).toBe(claves.length)
  })

  it('los estados terminales no tienen salida', () => {
    for (const e of ESTADOS_TERMINALES) expect(salidas(e), e).toEqual([])
  })

  it('todo estado es alcanzable desde el inicial', () => {
    const vistos = new Set<string>([ESTADO_INICIAL])
    const cola = [ESTADO_INICIAL as string]
    while (cola.length > 0) {
      const actual = cola.shift() as string
      for (const h of salidas(actual)) if (!vistos.has(h)) { vistos.add(h); cola.push(h) }
    }
    for (const e of ESTADOS_SOLICITUD) expect(vistos.has(e), `${e} no es alcanzable`).toBe(true)
  })

  it('todo estado no terminal tiene camino a un estado terminal', () => {
    const llegaATerminal = (desde: string, vistos = new Set<string>()): boolean => {
      if (esEstadoTerminal(desde as never)) return true
      if (vistos.has(desde)) return false
      vistos.add(desde)
      return salidas(desde).some((h) => llegaATerminal(h, vistos))
    }
    for (const e of ESTADOS_SOLICITUD) expect(llegaATerminal(e), `${e} no llega a un estado terminal`).toBe(true)
  })

  it('toda transición hacia RECHAZADA o DESISTIDA exige motivo, y ninguna otra', () => {
    for (const t of TRANSICIONES) {
      const esCierre = t.hacia === 'RECHAZADA' || t.hacia === 'DESISTIDA'
      expect(t.requiereMotivo === true, `${t.desde}->${t.hacia}`).toBe(esCierre)
    }
  })

  it('cada estado de cierre tiene motivos definidos', () => {
    expect(MOTIVOS_POR_ESTADO.RECHAZADA.length).toBeGreaterThan(0)
    expect(MOTIVOS_POR_ESTADO.DESISTIDA.length).toBeGreaterThan(0)
  })
})

describe('transicionesDesde', () => {
  it('filtra por rol mínimo', () => {
    expect(transicionesDesde('APROBADA', 'ADMIN').map((t) => t.hacia)).toEqual(['DESEMBOLSADA', 'DESISTIDA'])
    expect(transicionesDesde('APROBADA', 'GESTOR').map((t) => t.hacia)).toEqual(['DESISTIDA'])
  })

  it('devuelve vacío para estados terminales', () => {
    expect(transicionesDesde('DESEMBOLSADA', 'ADMIN')).toEqual([])
  })
})

describe('transicionesDisponibles', () => {
  it('oculta las transiciones cuya guarda no se cumple', () => {
    expect(transicionesDisponibles('DOCUMENTOS_PENDIENTES', 'GESTOR', {}).map((t) => t.hacia)).toEqual([
      'RECHAZADA',
      'DESISTIDA',
    ])
    expect(
      transicionesDisponibles('DOCUMENTOS_PENDIENTES', 'GESTOR', { documentosVigentes: true }).map((t) => t.hacia),
    ).toEqual(['EN_EVALUACION', 'RECHAZADA', 'DESISTIDA'])
  })
})

describe('evaluarCambioEstado', () => {
  it('acepta una transición simple sin guarda', () => {
    const r = evaluarCambioEstado({ desde: 'NUEVA', hacia: 'CONTACTADO', rol: 'GESTOR' })
    expect(r).toEqual({ ok: true, guarda: null, requiereMotivo: false })
  })

  it('devuelve la guarda que la API debe comprobar', () => {
    const r = evaluarCambioEstado({ desde: 'DOCUMENTOS_PENDIENTES', hacia: 'EN_EVALUACION', rol: 'GESTOR' })
    expect(r).toEqual({ ok: true, guarda: 'documentosVigentes', requiereMotivo: false })
  })

  it('rechaza una transición que no existe', () => {
    const r = evaluarCambioEstado({ desde: 'NUEVA', hacia: 'DESEMBOLSADA', rol: 'ADMIN' })
    expect(r).toEqual({ ok: false, razon: 'TRANSICION_NO_PERMITIDA' })
  })

  it('rechaza por rol insuficiente', () => {
    const r = evaluarCambioEstado({ desde: 'APROBADA', hacia: 'DESEMBOLSADA', rol: 'GESTOR' })
    expect(r).toEqual({ ok: false, razon: 'ROL_INSUFICIENTE' })
  })

  it('exige motivo en los cierres y que sea válido para ese estado', () => {
    expect(evaluarCambioEstado({ desde: 'NUEVA', hacia: 'DESISTIDA', rol: 'GESTOR' })).toEqual({
      ok: false,
      razon: 'MOTIVO_REQUERIDO',
    })
    expect(
      evaluarCambioEstado({ desde: 'NUEVA', hacia: 'DESISTIDA', rol: 'GESTOR', motivoCodigo: 'DOCUMENTOS_INVALIDOS' }),
    ).toEqual({ ok: false, razon: 'MOTIVO_NO_VALIDO' })
    expect(
      evaluarCambioEstado({ desde: 'NUEVA', hacia: 'DESISTIDA', rol: 'GESTOR', motivoCodigo: 'SPAM_O_INVALIDA' }),
    ).toEqual({ ok: true, guarda: null, requiereMotivo: true })
  })
})

describe('cambioEstadoSchema (cuerpo del PATCH de la API)', () => {
  it('acepta hacia, versión y motivo opcional', () => {
    expect(cambioEstadoSchema.safeParse({ hacia: 'CONTACTADO', version: 3 }).success).toBe(true)
    expect(
      cambioEstadoSchema.safeParse({ hacia: 'DESISTIDA', version: 3, motivoCodigo: 'SIN_RESPUESTA', motivoDetalle: 'Tres llamadas' }).success,
    ).toBe(true)
  })

  it('rechaza estados desconocidos y versiones no enteras', () => {
    expect(cambioEstadoSchema.safeParse({ hacia: 'CERRADA', version: 1 }).success).toBe(false)
    expect(cambioEstadoSchema.safeParse({ hacia: 'CONTACTADO', version: 1.5 }).success).toBe(false)
  })
})
```

- [ ] **Step 2: Correr y verificar que fallan**

Run: `pnpm --filter @anticipate/shared test -- usuario solicitud`
Expected: FAIL por módulos inexistentes.

- [ ] **Step 3: Implementar `usuario`**

`packages/shared/src/usuario/roles.ts`:
```ts
import { z } from 'zod'

/** Roles del admin, de menor a mayor. Agregar uno = agregarlo aquí en su posición. */
export const ROLES = ['GESTOR', 'ADMIN'] as const
export type Rol = (typeof ROLES)[number]
export const rolSchema = z.enum(ROLES)

export const NOMBRE_ROL: Record<Rol, string> = { GESTOR: 'Gestor', ADMIN: 'Administrador' }

export function rolAlcanza(rol: Rol, minimo: Rol): boolean {
  return ROLES.indexOf(rol) >= ROLES.indexOf(minimo)
}
```

`packages/shared/src/usuario/index.ts`:
```ts
export { NOMBRE_ROL, ROLES, type Rol, rolAlcanza, rolSchema } from './roles.js'
```

- [ ] **Step 4: Implementar `solicitud` · estados y motivos**

`packages/shared/src/solicitud/estados.ts`:
```ts
import { z } from 'zod'

export const ESTADOS_SOLICITUD = [
  'NUEVA',
  'NO_CONTESTA',
  'CONTACTADO',
  'DOCUMENTOS_PENDIENTES',
  'EN_EVALUACION',
  'PROFORMA_ENVIADA',
  'APROBADA',
  'DESEMBOLSADA',
  'RECHAZADA',
  'DESISTIDA',
] as const
export type EstadoSolicitud = (typeof ESTADOS_SOLICITUD)[number]
export const estadoSolicitudSchema = z.enum(ESTADOS_SOLICITUD)

export const ESTADO_INICIAL = 'NUEVA' satisfies EstadoSolicitud

export const ESTADOS_TERMINALES = ['DESEMBOLSADA', 'RECHAZADA', 'DESISTIDA'] as const satisfies readonly EstadoSolicitud[]
export type EstadoTerminal = (typeof ESTADOS_TERMINALES)[number]

export function esEstadoTerminal(estado: EstadoSolicitud): estado is EstadoTerminal {
  return (ESTADOS_TERMINALES as readonly string[]).includes(estado)
}

export const NOMBRE_ESTADO: Record<EstadoSolicitud, string> = {
  NUEVA: 'Nueva',
  NO_CONTESTA: 'No contesta',
  CONTACTADO: 'Contactado',
  DOCUMENTOS_PENDIENTES: 'Documentos pendientes',
  EN_EVALUACION: 'En evaluación',
  PROFORMA_ENVIADA: 'Proforma enviada',
  APROBADA: 'Aprobada',
  DESEMBOLSADA: 'Desembolsada',
  RECHAZADA: 'Rechazada',
  DESISTIDA: 'Desistida',
}
```

`packages/shared/src/solicitud/motivos.ts`:
```ts
import { z } from 'zod'

export const MOTIVOS_CIERRE = [
  'SIN_RESPUESTA',
  'SPAM_O_INVALIDA',
  'PROVEEDOR_SE_RETIRA',
  'DOCUMENTOS_INVALIDOS',
  'FACTURA_NO_ELEGIBLE',
  'RIESGO_NO_ACEPTABLE',
  'OTRO',
] as const
export type MotivoCierre = (typeof MOTIVOS_CIERRE)[number]
export const motivoSchema = z.enum(MOTIVOS_CIERRE)

export const NOMBRE_MOTIVO: Record<MotivoCierre, string> = {
  SIN_RESPUESTA: 'El proveedor no respondió',
  SPAM_O_INVALIDA: 'Solicitud de prueba, spam o inválida',
  PROVEEDOR_SE_RETIRA: 'El proveedor decidió no continuar',
  DOCUMENTOS_INVALIDOS: 'Documentos incompletos o inválidos',
  FACTURA_NO_ELEGIBLE: 'La factura no cumple los requisitos',
  RIESGO_NO_ACEPTABLE: 'Riesgo no aceptable',
  OTRO: 'Otro motivo (ver detalle)',
}

/** Qué motivos tienen sentido para cada estado de cierre. */
export const MOTIVOS_POR_ESTADO = {
  RECHAZADA: ['DOCUMENTOS_INVALIDOS', 'FACTURA_NO_ELEGIBLE', 'RIESGO_NO_ACEPTABLE', 'SPAM_O_INVALIDA', 'OTRO'],
  DESISTIDA: ['SIN_RESPUESTA', 'PROVEEDOR_SE_RETIRA', 'SPAM_O_INVALIDA', 'OTRO'],
} as const satisfies Record<'RECHAZADA' | 'DESISTIDA', readonly MotivoCierre[]>
```

- [ ] **Step 5: Implementar `solicitud` · transiciones**

`packages/shared/src/solicitud/transiciones.ts`:
```ts
import { z } from 'zod'
import { type Rol, rolAlcanza, rolSchema } from '../usuario/index.js'
import { type EstadoSolicitud, estadoSolicitudSchema } from './estados.js'
import { MOTIVOS_POR_ESTADO, type MotivoCierre, motivoSchema } from './motivos.js'

/** Nombres de guardas. La API las implementa (necesitan base de datos); shared solo las nombra. */
export const GUARDAS = ['documentosVigentes'] as const
export type Guarda = (typeof GUARDAS)[number]

export type Transicion = {
  desde: EstadoSolicitud
  hacia: EstadoSolicitud
  guarda?: Guarda
  rolMinimo?: Rol
  requiereMotivo?: true
}

/** Única fuente de verdad de la máquina de estados (STACK §9). El admin pinta botones con esto; la API lo hace cumplir. */
export const TRANSICIONES = [
  { desde: 'NUEVA', hacia: 'CONTACTADO' },
  { desde: 'NUEVA', hacia: 'NO_CONTESTA' },
  { desde: 'NUEVA', hacia: 'DESISTIDA', requiereMotivo: true },
  { desde: 'NO_CONTESTA', hacia: 'CONTACTADO' },
  { desde: 'NO_CONTESTA', hacia: 'DESISTIDA', requiereMotivo: true },
  { desde: 'CONTACTADO', hacia: 'DOCUMENTOS_PENDIENTES' },
  { desde: 'CONTACTADO', hacia: 'DESISTIDA', requiereMotivo: true },
  { desde: 'DOCUMENTOS_PENDIENTES', hacia: 'EN_EVALUACION', guarda: 'documentosVigentes' },
  { desde: 'DOCUMENTOS_PENDIENTES', hacia: 'RECHAZADA', requiereMotivo: true },
  { desde: 'DOCUMENTOS_PENDIENTES', hacia: 'DESISTIDA', requiereMotivo: true },
  { desde: 'EN_EVALUACION', hacia: 'PROFORMA_ENVIADA' },
  { desde: 'EN_EVALUACION', hacia: 'RECHAZADA', requiereMotivo: true },
  { desde: 'PROFORMA_ENVIADA', hacia: 'APROBADA' },
  { desde: 'PROFORMA_ENVIADA', hacia: 'DESISTIDA', requiereMotivo: true },
  { desde: 'APROBADA', hacia: 'DESEMBOLSADA', rolMinimo: 'ADMIN' },
  { desde: 'APROBADA', hacia: 'DESISTIDA', requiereMotivo: true },
] as const satisfies readonly Transicion[]

export function transicionesDesde(desde: EstadoSolicitud, rol: Rol): Transicion[] {
  return TRANSICIONES.filter((t) => t.desde === desde && rolAlcanza(rol, t.rolMinimo ?? 'GESTOR'))
}

/** Hechos que la API calcula con la base de datos para resolver las guardas. */
export type Hechos = Partial<Record<Guarda, boolean>>

/** Lo que el usuario puede hacer ahora mismo: filtra por rol y por guardas ya resueltas. La API lo devuelve como `accionesPermitidas`. */
export function transicionesDisponibles(desde: EstadoSolicitud, rol: Rol, hechos: Hechos): Transicion[] {
  return transicionesDesde(desde, rol).filter((t) => t.guarda === undefined || hechos[t.guarda] === true)
}

export type CambioEstado = {
  desde: EstadoSolicitud
  hacia: EstadoSolicitud
  rol: Rol
  motivoCodigo?: MotivoCierre
}

export type ResultadoCambio =
  | { ok: true; guarda: Guarda | null; requiereMotivo: boolean }
  | { ok: false; razon: 'TRANSICION_NO_PERMITIDA' | 'ROL_INSUFICIENTE' | 'MOTIVO_REQUERIDO' | 'MOTIVO_NO_VALIDO' }

/** Evaluación pura. Si devuelve `guarda`, la API debe comprobarla contra la base de datos antes de aplicar el cambio. */
export function evaluarCambioEstado(cambio: CambioEstado): ResultadoCambio {
  const t = TRANSICIONES.find((x) => x.desde === cambio.desde && x.hacia === cambio.hacia)
  if (!t) return { ok: false, razon: 'TRANSICION_NO_PERMITIDA' }
  if (!rolAlcanza(cambio.rol, t.rolMinimo ?? 'GESTOR')) return { ok: false, razon: 'ROL_INSUFICIENTE' }
  const requiereMotivo = t.requiereMotivo === true
  if (requiereMotivo) {
    if (!cambio.motivoCodigo) return { ok: false, razon: 'MOTIVO_REQUERIDO' }
    const permitidos = MOTIVOS_POR_ESTADO[t.hacia as keyof typeof MOTIVOS_POR_ESTADO] as readonly MotivoCierre[]
    if (!permitidos.includes(cambio.motivoCodigo)) return { ok: false, razon: 'MOTIVO_NO_VALIDO' }
  }
  return { ok: true, guarda: t.guarda ?? null, requiereMotivo }
}

/** Cuerpo de `PATCH /admin/solicitudes/:id/estado`. `version` sostiene el bloqueo optimista (D28). */
export const cambioEstadoSchema = z.object({
  hacia: estadoSolicitudSchema,
  version: z.number().int().nonnegative(),
  motivoCodigo: motivoSchema.optional(),
  motivoDetalle: z.string().trim().max(500).optional(),
})
export type CambioEstadoDto = z.infer<typeof cambioEstadoSchema>

export { rolSchema }
```

`packages/shared/src/solicitud/index.ts` (formulario y código se agregan en la Tarea 8):
```ts
export {
  ESTADO_INICIAL,
  ESTADOS_SOLICITUD,
  ESTADOS_TERMINALES,
  type EstadoSolicitud,
  type EstadoTerminal,
  esEstadoTerminal,
  estadoSolicitudSchema,
  NOMBRE_ESTADO,
} from './estados.js'
export { MOTIVOS_CIERRE, MOTIVOS_POR_ESTADO, type MotivoCierre, motivoSchema, NOMBRE_MOTIVO } from './motivos.js'
export {
  type CambioEstado,
  type CambioEstadoDto,
  cambioEstadoSchema,
  evaluarCambioEstado,
  GUARDAS,
  type Guarda,
  type Hechos,
  type ResultadoCambio,
  TRANSICIONES,
  type Transicion,
  transicionesDesde,
  transicionesDisponibles,
} from './transiciones.js'
```

Agregar a `packages/shared/src/index.ts`:
```ts
export * from './usuario/index.js'
export * from './solicitud/index.js'
```

- [ ] **Step 6: Correr tests y verificación completa**

Run: `pnpm --filter @anticipate/shared test && pnpm typecheck && pnpm lint`
Expected: todos PASS. En particular los cinco tests estructurales: si alguien quita una flecha de cierre, "todo estado no terminal tiene camino a un estado terminal" falla en CI.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src
git commit -m "feat(shared): máquina de estados como datos con guardas, roles, motivos y test estructural"
```

---

### Task 8: Dominio `solicitud` · esquema del formulario y código público

**Files:**
- Create: `packages/shared/src/solicitud/formulario.ts`, `packages/shared/src/solicitud/codigo.ts`
- Test: `packages/shared/src/solicitud/formulario.test.ts`, `packages/shared/src/solicitud/codigo.test.ts`
- Modify: `packages/shared/src/solicitud/index.ts`

**Interfaces:**
- Consumes: `rucSchema`, `dniSchema` (Tarea 3); `montoSchema` (Tarea 4).
- Produces: `HORARIOS_CONTACTO`, `REGISTRO_CAVALI`, `solicitudFormularioSchema`, `SolicitudFormulario`; `formatearCodigoSolicitud({ prefijo, anio, secuencia })`, `parsearCodigoSolicitud(texto)`. La landing lo usa con `zodResolver`; la API como DTO del campo JSON del multipart (los archivos se validan aparte, STACK §8).

- [ ] **Step 1: Escribir los tests que fallan**

`packages/shared/src/solicitud/formulario.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { solicitudFormularioSchema } from './formulario.js'

const valido = {
  contacto: {
    nombre: 'Ana Pérez',
    dni: '46728673',
    celular: '987654321',
    correo: 'ana@proveedor.pe',
    esRepresentanteLegal: true,
    horarioContacto: 'MANANA',
  },
  empresa: { ruc: '20100070970', razonSocial: 'PROVEEDOR EJEMPLO S.A.C.' },
  financiamiento: { montoSolicitado: '8000.00', motivo: 'Capital de trabajo' },
  registroCavali: 'NO_SE',
  consentimientos: { terminos: true, datosPersonales: true, versionTerminos: '2026-09', versionPrivacidad: '2026-09' },
  origen: { utm: { utm_source: 'linkedin' }, referrer: 'https://www.linkedin.com/' },
}

describe('solicitudFormularioSchema', () => {
  it('acepta un formulario completo', () => {
    expect(solicitudFormularioSchema.safeParse(valido).success).toBe(true)
  })

  it('exige cargo cuando el contacto no es representante legal', () => {
    const r = solicitudFormularioSchema.safeParse({
      ...valido,
      contacto: { ...valido.contacto, esRepresentanteLegal: false },
    })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['contacto', 'cargo'])
  })

  it('acepta cargo cuando no es representante', () => {
    const r = solicitudFormularioSchema.safeParse({
      ...valido,
      contacto: { ...valido.contacto, esRepresentanteLegal: false, cargo: 'Contadora' },
    })
    expect(r.success).toBe(true)
  })

  it('exige ambos consentimientos en true', () => {
    const r = solicitudFormularioSchema.safeParse({
      ...valido,
      consentimientos: { ...valido.consentimientos, datosPersonales: false },
    })
    expect(r.success).toBe(false)
  })

  it('valida celular peruano de 9 dígitos que empieza en 9', () => {
    for (const celular of ['98765432', '187654321', '9876 54321']) {
      const r = solicitudFormularioSchema.safeParse({ ...valido, contacto: { ...valido.contacto, celular } })
      expect(r.success, celular).toBe(false)
    }
  })

  it('normaliza correo a minúsculas y recorta espacios', () => {
    const r = solicitudFormularioSchema.parse({ ...valido, contacto: { ...valido.contacto, correo: '  Ana@Proveedor.PE ' } })
    expect(r.contacto.correo).toBe('ana@proveedor.pe')
  })

  it('origen es opcional y sus utm se limitan a claves utm_*', () => {
    const { origen: _sin, ...sinOrigen } = valido
    expect(solicitudFormularioSchema.safeParse(sinOrigen).success).toBe(true)
    const r = solicitudFormularioSchema.safeParse({ ...valido, origen: { utm: { password: 'x' } } })
    expect(r.success).toBe(false)
  })
})
```

`packages/shared/src/solicitud/codigo.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { formatearCodigoSolicitud, parsearCodigoSolicitud } from './codigo.js'

describe('código público de solicitud', () => {
  it('formatea con prefijo, año y secuencia de seis dígitos', () => {
    expect(formatearCodigoSolicitud({ prefijo: 'ANT', anio: 2026, secuencia: 123 })).toBe('ANT-2026-000123')
    expect(formatearCodigoSolicitud({ prefijo: 'ANT', anio: 2026, secuencia: 1_234_567 })).toBe('ANT-2026-1234567')
  })

  it('parsea y rechaza formatos ajenos', () => {
    expect(parsearCodigoSolicitud('ANT-2026-000123')).toEqual({ prefijo: 'ANT', anio: 2026, secuencia: 123 })
    expect(parsearCodigoSolicitud('ant-2026-000123')).toEqual({ prefijo: 'ANT', anio: 2026, secuencia: 123 })
    expect(parsearCodigoSolicitud('2026-000123')).toBeNull()
    expect(parsearCodigoSolicitud('ANT-26-1')).toBeNull()
  })
})
```

- [ ] **Step 2: Correr y verificar que fallan**

Run: `pnpm --filter @anticipate/shared test -- formulario codigo`
Expected: FAIL por módulos inexistentes.

- [ ] **Step 3: Implementar**

`packages/shared/src/solicitud/formulario.ts`:
```ts
import { z } from 'zod'
import { montoSchema } from '../dinero/index.js'
import { dniSchema, rucSchema } from '../identidad/index.js'

export const HORARIOS_CONTACTO = ['MANANA', 'TARDE', 'CUALQUIERA'] as const
export const NOMBRE_HORARIO: Record<(typeof HORARIOS_CONTACTO)[number], string> = {
  MANANA: 'Por la mañana (9 a 13 h)',
  TARDE: 'Por la tarde (14 a 18 h)',
  CUALQUIERA: 'Cualquier horario',
}

export const REGISTRO_CAVALI = ['SI', 'NO', 'NO_SE'] as const

const celularSchema = z
  .string()
  .trim()
  .regex(/^9\d{8}$/, { error: 'El celular debe tener 9 dígitos y empezar con 9.' })

const correoSchema = z.string().trim().toLowerCase().pipe(z.email({ error: 'El correo no es válido.' }))

const contactoSchema = z
  .object({
    nombre: z.string().trim().min(3, 'Escribe tu nombre completo.').max(120),
    dni: dniSchema,
    celular: celularSchema,
    correo: correoSchema,
    esRepresentanteLegal: z.boolean(),
    cargo: z.string().trim().min(2).max(80).optional(),
    horarioContacto: z.enum(HORARIOS_CONTACTO),
  })
  .superRefine((c, ctx) => {
    if (!c.esRepresentanteLegal && !c.cargo) {
      ctx.addIssue({ code: 'custom', path: ['cargo'], message: 'Indica tu cargo en la empresa.' })
    }
  })

const utmSchema = z.record(z.string().regex(/^utm_[a-z_]+$/), z.string().trim().max(200))

/** Campo JSON del `multipart/form-data` de `POST /solicitudes`. Los archivos van aparte. */
export const solicitudFormularioSchema = z.object({
  contacto: contactoSchema,
  empresa: z.object({
    ruc: rucSchema,
    razonSocial: z.string().trim().min(3).max(200),
  }),
  financiamiento: z.object({
    montoSolicitado: montoSchema,
    motivo: z.string().trim().max(500).optional(),
  }),
  registroCavali: z.enum(REGISTRO_CAVALI),
  consentimientos: z.object({
    terminos: z.literal(true, { error: 'Debes aceptar los términos y condiciones.' }),
    datosPersonales: z.literal(true, { error: 'Debes autorizar el tratamiento de tus datos personales.' }),
    versionTerminos: z.string().min(1),
    versionPrivacidad: z.string().min(1),
  }),
  origen: z
    .object({
      utm: utmSchema.optional(),
      referrer: z.url().max(2000).optional(),
    })
    .optional(),
})
export type SolicitudFormulario = z.infer<typeof solicitudFormularioSchema>
```

`packages/shared/src/solicitud/codigo.ts`:
```ts
export type CodigoSolicitud = { prefijo: string; anio: number; secuencia: number }

/** `ANT-2026-000123`. El prefijo y la secuencia los da la API (config y secuencia de PostgreSQL). */
export function formatearCodigoSolicitud({ prefijo, anio, secuencia }: CodigoSolicitud): string {
  return `${prefijo.toUpperCase()}-${anio}-${String(secuencia).padStart(6, '0')}`
}

export function parsearCodigoSolicitud(texto: string): CodigoSolicitud | null {
  const m = /^([A-Za-z]{2,6})-(\d{4})-(\d{6,})$/.exec(texto.trim())
  if (!m) return null
  return { prefijo: (m[1] ?? '').toUpperCase(), anio: Number(m[2]), secuencia: Number(m[3]) }
}
```

Agregar a `packages/shared/src/solicitud/index.ts`:
```ts
export { type CodigoSolicitud, formatearCodigoSolicitud, parsearCodigoSolicitud } from './codigo.js'
export {
  HORARIOS_CONTACTO,
  NOMBRE_HORARIO,
  REGISTRO_CAVALI,
  type SolicitudFormulario,
  solicitudFormularioSchema,
} from './formulario.js'
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

### Task 9: Dominios `documento` y `pagador`

**Files:**
- Create: `packages/shared/src/documento/vigencia.ts`, `packages/shared/src/documento/index.ts`
- Create: `packages/shared/src/pagador/esquema.ts`, `packages/shared/src/pagador/index.ts`
- Test: `packages/shared/src/documento/vigencia.test.ts`, `packages/shared/src/pagador/esquema.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `FechaIso`, `diasEntre`, `fechaIsoSchema` (Tarea 4); `rucSchema` (Tarea 3).
- Produces: `TIPOS_DOCUMENTO`, `ESTADOS_DOCUMENTO`, `ReglasVigencia`, `calcularValidoHasta(tipo, datos, reglas)`, `estaVigente(doc, hoy)`, `documentoTieneVigenciaRequerida(tipo)`; `pagadorPublicoSchema`, `PagadorPublico`, `esColorHexValido`. La API usa `calcularValidoHasta` al aprobar un documento y `estaVigente` en la guarda `documentosVigentes`; la landing recibe `PagadorPublico` de `GET /pagadores`.

- [ ] **Step 1: Escribir los tests que fallan**

`packages/shared/src/documento/vigencia.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { calcularValidoHasta, estaVigente, type ReglasVigencia } from './vigencia.js'

const reglas: ReglasVigencia = { diasVigenciaPoder: 90 }

describe('calcularValidoHasta', () => {
  it('vigencia de poder: fecha de emisión más los días del contexto', () => {
    expect(calcularValidoHasta('VIGENCIA_PODER', { fechaEmision: '2026-09-01' }, reglas)).toBe('2026-11-30')
    expect(calcularValidoHasta('VIGENCIA_PODER', { fechaEmision: '2026-09-01' }, { diasVigenciaPoder: 30 })).toBe('2026-10-01')
  })

  it('DNI: hasta su fecha de caducidad', () => {
    expect(calcularValidoHasta('DNI_REPRESENTANTE', { fechaCaducidad: '2030-05-20' }, reglas)).toBe('2030-05-20')
  })

  it('contrato marco y otros: sin vencimiento', () => {
    expect(calcularValidoHasta('CONTRATO_MARCO', {}, reglas)).toBeNull()
    expect(calcularValidoHasta('OTRO', {}, reglas)).toBeNull()
  })

  it('lanza si falta el dato que el tipo necesita', () => {
    expect(() => calcularValidoHasta('VIGENCIA_PODER', {}, reglas)).toThrow()
    expect(() => calcularValidoHasta('DNI_REPRESENTANTE', {}, reglas)).toThrow()
  })
})

describe('estaVigente', () => {
  it('solo un documento aprobado y no vencido está vigente', () => {
    expect(estaVigente({ estado: 'APROBADO', validoHasta: '2026-12-31' }, '2026-09-23')).toBe(true)
    expect(estaVigente({ estado: 'APROBADO', validoHasta: '2026-09-23' }, '2026-09-23')).toBe(true)
    expect(estaVigente({ estado: 'APROBADO', validoHasta: '2026-09-22' }, '2026-09-23')).toBe(false)
    expect(estaVigente({ estado: 'APROBADO', validoHasta: null }, '2026-09-23')).toBe(true)
    expect(estaVigente({ estado: 'PENDIENTE_REVISION', validoHasta: null }, '2026-09-23')).toBe(false)
    expect(estaVigente({ estado: 'RECHAZADO', validoHasta: '2099-01-01' }, '2026-09-23')).toBe(false)
  })
})
```

`packages/shared/src/pagador/esquema.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { esColorHexValido, pagadorPublicoSchema } from './esquema.js'

const sea = {
  slug: 'sea',
  ruc: '20131312955',
  razonSocial: 'Servicios Energéticos Ambientales S.A.',
  nombreCorto: 'SEA',
  porcentajeAdelanto: 80,
  plazoMinimoDias: 15,
  maxFacturas: 10,
  monedasPermitidas: ['PEN', 'USD'],
  colorAcento: '#0E7C86',
  logoUrl: 'https://cdn.ejemplo.pe/sea.svg',
  textos: { titulo: 'Adelanta tus facturas a SEA', subtitulo: 'Cobra hoy lo que SEA te pagará en 60 días' },
}

describe('pagadorPublicoSchema', () => {
  it('acepta un pagador completo', () => {
    expect(pagadorPublicoSchema.safeParse(sea).success).toBe(true)
  })

  it('el slug es kebab-case en minúsculas', () => {
    for (const slug of ['SEA', 'sea 2', 'sea_2', '-sea']) {
      expect(pagadorPublicoSchema.safeParse({ ...sea, slug }).success, slug).toBe(false)
    }
    expect(pagadorPublicoSchema.safeParse({ ...sea, slug: 'sea-2' }).success).toBe(true)
  })

  it('el porcentaje está entre 1 y 100 con hasta dos decimales', () => {
    expect(pagadorPublicoSchema.safeParse({ ...sea, porcentajeAdelanto: 0 }).success).toBe(false)
    expect(pagadorPublicoSchema.safeParse({ ...sea, porcentajeAdelanto: 100.5 }).success).toBe(false)
    expect(pagadorPublicoSchema.safeParse({ ...sea, porcentajeAdelanto: 33.333 }).success).toBe(false)
    expect(pagadorPublicoSchema.safeParse({ ...sea, porcentajeAdelanto: 33.33 }).success).toBe(true)
  })

  it('logo opcional y color hexadecimal', () => {
    expect(pagadorPublicoSchema.safeParse({ ...sea, logoUrl: null }).success).toBe(true)
    expect(pagadorPublicoSchema.safeParse({ ...sea, colorAcento: 'azul' }).success).toBe(false)
    expect(esColorHexValido('#abc')).toBe(true)
    expect(esColorHexValido('#0E7C86')).toBe(true)
    expect(esColorHexValido('0E7C86')).toBe(false)
  })
})
```

- [ ] **Step 2: Correr y verificar que fallan**

Run: `pnpm --filter @anticipate/shared test -- documento pagador`
Expected: FAIL por módulos inexistentes.

- [ ] **Step 3: Implementar `documento`**

`packages/shared/src/documento/vigencia.ts`:
```ts
import { z } from 'zod'
import { type FechaIso, diasEntre, esFechaIso } from '../fechas/index.js'

export const TIPOS_DOCUMENTO = ['DNI_REPRESENTANTE', 'VIGENCIA_PODER', 'CONTRATO_MARCO', 'OTRO'] as const
export type TipoDocumento = (typeof TIPOS_DOCUMENTO)[number]
export const tipoDocumentoSchema = z.enum(TIPOS_DOCUMENTO)

export const ESTADOS_DOCUMENTO = ['PENDIENTE_REVISION', 'APROBADO', 'RECHAZADO'] as const
export type EstadoDocumento = (typeof ESTADOS_DOCUMENTO)[number]
export const estadoDocumentoSchema = z.enum(ESTADOS_DOCUMENTO)

export const NOMBRE_TIPO_DOCUMENTO: Record<TipoDocumento, string> = {
  DNI_REPRESENTANTE: 'DNI del representante legal',
  VIGENCIA_PODER: 'Vigencia de poder (SUNARP)',
  CONTRATO_MARCO: 'Contrato marco',
  OTRO: 'Otro documento',
}

/** Parámetros de negocio; la API los toma de su configuración. */
export type ReglasVigencia = { diasVigenciaPoder: number }

export type DatosVigencia = { fechaEmision?: FechaIso; fechaCaducidad?: FechaIso }

function sumarDias(fecha: FechaIso, dias: number): FechaIso {
  const [a, m, d] = fecha.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(a, m - 1, d + dias)).toISOString().slice(0, 10)
}

/** Fecha hasta la que el documento vale, o null si no vence. Lanza si falta el dato que el tipo exige. */
export function calcularValidoHasta(tipo: TipoDocumento, datos: DatosVigencia, reglas: ReglasVigencia): FechaIso | null {
  switch (tipo) {
    case 'VIGENCIA_PODER': {
      if (!datos.fechaEmision || !esFechaIso(datos.fechaEmision)) throw new Error('VIGENCIA_PODER requiere fechaEmision')
      return sumarDias(datos.fechaEmision, reglas.diasVigenciaPoder)
    }
    case 'DNI_REPRESENTANTE': {
      if (!datos.fechaCaducidad || !esFechaIso(datos.fechaCaducidad)) throw new Error('DNI_REPRESENTANTE requiere fechaCaducidad')
      return datos.fechaCaducidad
    }
    case 'CONTRATO_MARCO':
    case 'OTRO':
      return null
  }
}

export function documentoTieneVigenciaRequerida(tipo: TipoDocumento): boolean {
  return tipo === 'VIGENCIA_PODER' || tipo === 'DNI_REPRESENTANTE'
}

export type DocumentoVigencia = { estado: EstadoDocumento; validoHasta: FechaIso | null }

/** Aprobado y con `validoHasta` de hoy en adelante (o sin vencimiento). */
export function estaVigente(doc: DocumentoVigencia, hoy: FechaIso): boolean {
  if (doc.estado !== 'APROBADO') return false
  if (doc.validoHasta === null) return true
  return diasEntre(hoy, doc.validoHasta) >= 0
}
```

`packages/shared/src/documento/index.ts`:
```ts
export {
  calcularValidoHasta,
  type DatosVigencia,
  documentoTieneVigenciaRequerida,
  type DocumentoVigencia,
  ESTADOS_DOCUMENTO,
  type EstadoDocumento,
  estaVigente,
  estadoDocumentoSchema,
  NOMBRE_TIPO_DOCUMENTO,
  type ReglasVigencia,
  TIPOS_DOCUMENTO,
  type TipoDocumento,
  tipoDocumentoSchema,
} from './vigencia.js'
```

- [ ] **Step 4: Implementar `pagador`**

`packages/shared/src/pagador/esquema.ts`:
```ts
import { z } from 'zod'
import { MONEDAS } from '../dinero/index.js'
import { rucSchema } from '../identidad/index.js'

const COLOR_HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

export function esColorHexValido(valor: string): boolean {
  return COLOR_HEX.test(valor)
}

export const slugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { error: 'El slug solo admite minúsculas, números y guiones.' })
  .max(60)

/** Lo que la landing recibe de `GET /pagadores`: solo campos públicos (STACK §8). */
export const pagadorPublicoSchema = z.object({
  slug: slugSchema,
  ruc: rucSchema,
  razonSocial: z.string().trim().min(3).max(200),
  nombreCorto: z.string().trim().min(2).max(40),
  porcentajeAdelanto: z.number().min(1).max(100).multipleOf(0.01),
  plazoMinimoDias: z.number().int().min(0),
  maxFacturas: z.number().int().min(1),
  monedasPermitidas: z.array(z.enum(MONEDAS)).min(1),
  colorAcento: z.string().refine(esColorHexValido, { error: 'El color debe ser hexadecimal, por ejemplo #0E7C86.' }),
  logoUrl: z.url().nullable(),
  textos: z.record(z.string(), z.string()),
})
export type PagadorPublico = z.infer<typeof pagadorPublicoSchema>
```

`packages/shared/src/pagador/index.ts`:
```ts
export { esColorHexValido, type PagadorPublico, pagadorPublicoSchema, slugSchema } from './esquema.js'
```

Agregar a `packages/shared/src/index.ts`:
```ts
export * from './documento/index.js'
export * from './pagador/index.js'
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
- Modify: `docs/STACK.md` (secciones 4, 9 y 13: versiones fijadas, validación nativa de NestJS 12, `shared` en ESM, índices parciales de Prisma)

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
  verificar:
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
| `pnpm verificar` | Todo lo anterior, en orden. Es lo que corre CI |
| `pnpm test:watch` | Vitest en modo interactivo sobre todos los paquetes |

## Estructura

- `packages/shared`: esquemas, reglas de negocio, lector de XML y máquina de estados. Sin código de servidor ni de navegador.
- `packages/config`: presets de TypeScript.
- `apps/`: landing, admin y api (fases siguientes).

Las versiones se fijan en el `catalog` de `pnpm-workspace.yaml`; los `package.json` usan `catalog:`.
```

- [ ] **Step 3: Registrar en `docs/STACK.md` lo que la verificación de versiones cambió**

En la sección 4, tabla "Stack por capa":
- Fila "Lenguaje": cambiar `TypeScript (modo `strict`)` por `TypeScript 6 (modo `strict`; 7.0 no lo soportan el CLI de NestJS ni @nestjs/swagger)`.
- Fila "Runtime": cambiar `Node.js LTS activo` por `Node.js 24 LTS`.
- Fila "Validación y contratos": cambiar `Zod + `nestjs-zod`` por `Zod 4 + validación nativa de NestJS 12 (Standard Schema; `nestjs-zod` no soporta NestJS 12)`.
- Fila "Documentación API": cambiar `OpenAPI (Swagger) generado desde Zod` por `OpenAPI generado por @nestjs/swagger 12 directamente desde los esquemas Zod (≥ 4.2, sin conversor)`.
- Fila "Correos": cambiar `Brevo (API transaccional) + React Email` por `Brevo (API transaccional) + React Email 6 (paquete único `react-email`)`.

En la sección 9, fila "Duplicados" de las reglas de la factura: cambiar `escrito a mano en el SQL de la migración porque Prisma no expresa índices parciales` por `declarado en `schema.prisma` con la vista previa `partialIndexes` (Prisma ≥ 7.4); un índice parcial escrito a mano en SQL lo detecta como drift`. En D26, columna "Elegido", el mismo cambio.

En la sección 13 agregar al final:

```markdown
| D30 | Compilación de `packages/shared` | `tsdown` a ESM con tipos, `exports` por dominio, imports internos con `.js` | NestJS 12 es ESM y Node ≥ 22.12 tiene `require(esm)`; un solo formato evita el "dual package hazard" y el `dist` obsoleto | Dual ESM + CJS con `tsup` (sin mantenimiento); consumir el TypeScript fuente sin build (Turbopack no resuelve `./x.js` → `x.ts`) |
| D31 | Versiones fijadas de las fundaciones | Node 24, pnpm 12, TypeScript 6 vía alias `@typescript/typescript6`, Zod 4, Vitest 5, Biome 2.5, Prisma 7.10 sin caret | Verificadas contra npm y documentación oficial el 2026-09-23; TypeScript 7 y Prisma 8 (RC) rompen dependencias del stack | Última versión de cada paquete sin mirar compatibilidad |
| D32 | Validación en la API | Standard Schema nativo de NestJS 12 (`@Body({ schema })`) | `nestjs-zod` 5.5 no soporta NestJS 12; @nestjs/swagger 12 convierte esquemas Zod ≥ 4.2 sin configuración | `nestjs-zod` (D8 queda reemplazada por esta decisión) |
```

Y en el historial, fila 0.4, agregar al final: `; versiones fijadas y validación nativa de NestJS 12 (D30 a D32); documento movido a docs/`.

- [ ] **Step 4: Verificación completa y commit**

Run: `pnpm verificar`
Expected: lint, typecheck, test y build sin errores. Contar los tests: `pnpm test 2>&1 | grep -E "Tests|Test Files"` debe mostrar más de 80 tests en verde.

```bash
git add .github README.md docs
git commit -m "chore: CI con GitHub Actions, README y documento vivo en docs/"
```

- [ ] **Step 5: Abrir el pull request de la fase**

Si el repositorio ya tiene remoto en GitHub: crear rama `feat/fundaciones-y-shared` desde el primer commit y abrir el PR contra `main`. Si aún no hay remoto, los commits quedan en `main` local y el PR se hace cuando exista.

---

## Decisiones que este plan toma y que STACK.md no tenía escritas

| Tema | Decisión | Por qué |
|---|---|---|
| Compilación de `shared` | `tsdown` a ESM con tipos, `exports` por dominio, imports con `.js` | NestJS 12 es ESM; Node ≥ 22.12 tiene `require(esm)`; un solo formato evita el dual package hazard. Turbopack no resuelve `./x.js` → `x.ts`, así que consumir fuente sin build no es opción |
| Guardas de la máquina de estados | Nombres en `shared`, implementación en la API | `shared` no puede tocar Prisma; el admin solo necesita saber que la transición tiene condición |
| Motivos de cierre | Enum en `shared`, validado por estado destino | Métricas por motivo sin inventar estados (D27) |
| `rucProveedor` opcional en el contexto | La landing lee facturas antes de conocer el RUC | D22: el XML completa la empresa |
| Retención | No se lee todavía | Sin XML reales que la incluyan; el neto pendiente ya viene descontado |
| Turborepo | Desde el día 1, sin caché remota | Ordena `build` de packages antes que apps y cachea en local; cuesta un archivo de diez líneas |
| TypeScript 6 vía alias | `typescript@npm:@typescript/typescript6` | 7.0 es `latest` pero no tiene API programática y lo rechazan el CLI de NestJS 12 y @nestjs/swagger |
| `nestjs-zod` | Descartado | No soporta NestJS 12; la validación nativa con Standard Schema lo reemplaza (paso 2) |

## Self-review (hecho al escribir el plan)

- **Cobertura de STACK.md**: §4 stack raíz (Tarea 1), §5 estructura y reglas de dependencia (Tareas 1 y 2), §9 reglas de factura (Tarea 6), estados y transiciones con motivo codificado (Tarea 7), tipos y vigencia de documentos (Tarea 9), convenciones de dinero y fechas (Tarea 4), campos del formulario §6 (Tarea 8), campos públicos del pagador §8 (Tarea 9), tests obligatorios y test estructural §12 (Tareas 3, 6, 7), CI §12 (Tarea 10), actualización del documento con las versiones verificadas (Tarea 10). Fuera de este plan, a propósito: esquema Prisma, API, landing, admin, Docker Compose (pasos 2 a 4).
- **Verificación de versiones**: hecha el 2026-09-23 con seis agentes contra el registro npm y documentación oficial (Node, pnpm, TypeScript, NestJS, Prisma, Vitest, Biome, Astro, Next.js, fast-xml-parser, SUNAT). Pins y consecuencias incorporados en Global Constraints, Tarea 1, Tarea 2 y Tarea 10.
- **Placeholders**: los únicos valores por completar son las versiones del catálogo (Tarea 1, paso 2), que por diseño se toman de `pnpm view` en el momento de ejecutar.
- **Consistencia de nombres**: `crearProblema`, `Problema`, `Monto`, `normalizarMonto`, `FacturaLeida`, `ContextoValidacion`, `validarFacturas`, `evaluarCambioEstado`, `estaVigente`, `pagadorPublicoSchema` se usan con la misma firma en todas las tareas que los mencionan.
- **Review Focus**: los cinco puntos tienen test: BOM y CRLF (Tarea 5, "robustez de formato"), prefijos de espacio de nombres (Tarea 5), montos sin dos decimales (Tareas 4 y 5), cuota vencida entre cuotas futuras (Tarea 6), factura repetida y emisores distintos (Tarea 6).
