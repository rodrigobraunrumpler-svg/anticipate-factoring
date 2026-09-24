# Anticipate Factoring

Adelanto de facturas para proveedores de empresas pagadoras. Documento de arquitectura: [docs/STACK.md](docs/STACK.md).

## Requisitos

- Node.js 24.15 o superior (`.node-version`)
- pnpm 12.6 o superior, instalado de forma nativa (`corepack enable`)

Si `pnpm build` o `pnpm test` fallan con `Exec format error (os error 8)`, es que pnpm 12 quedó descargado sin su binario nativo (pasa cuando un pnpm 10 global lo descarga con los scripts bloqueados); se arregla instalando pnpm 12 directamente (`npm install -g pnpm@12` o `corepack enable && corepack prepare pnpm@12.6.0 --activate`).

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
| `pnpm --filter @anticipate/shared check:package` | Verifica `exports` y tipos del paquete compilado |

## Estructura

- `packages/shared`: esquemas, reglas de negocio, lector de XML y máquina de estados. Sin código de servidor ni de navegador.
- `packages/config`: presets de TypeScript.
- `apps/`: landing, admin y api (fases siguientes).

## Convenciones

- Código en inglés (identificadores, archivos, modelos); español en mensajes, textos, documentación, comentarios y commits. Glosario en `docs/STACK.md`.
- Las versiones se fijan en el `catalog` de `pnpm-workspace.yaml`; los `package.json` usan `catalog:`. Renovate propone actualizaciones agrupadas los lunes.
- Cada commit pasa por lefthook: Biome sobre lo cambiado y commitlint (Conventional Commits). Los commits son de una sola línea (Conventional Commits, sin cuerpo ni trailers).
- Montos con decimal.js y límite `Decimal(14, 2)`.
- El editor usa Biome como formateador (`.vscode/settings.json`).
- `packages/shared` tiene un test de arquitectura (dirección de dependencias entre dominios) y una suite dorada con XML reales anonimizados (`packages/shared/test/golden/README.md`).
