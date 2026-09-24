# Anticipate Factoring

Adelanto de facturas para proveedores de empresas pagadoras. Documento de arquitectura: [docs/STACK.md](docs/STACK.md).

## Requisitos

- Node.js 24 (24.15 o superior): `.node-version` fija la línea 24, `engines.node` acepta `>=24.15 <27` y `devEngines` descarga `^24.15.0` si falta
- pnpm 12.6 o superior instalado de forma nativa

Si `pnpm build` o `pnpm test` fallan con `Exec format error (os error 8)`, es que pnpm 12 quedó descargado sin su binario nativo (pasa cuando un pnpm 10 global lo descarga con los scripts bloqueados); se arregla instalando pnpm 12 directamente (`npm install -g pnpm@12` o `corepack enable && corepack prepare pnpm@12.6.0 --activate`).

## Comandos

| Comando | Qué hace |
|---|---|
| `pnpm install` | Instala todo el monorepo |
| `pnpm lint` | Biome: linter y formato |
| `pnpm typecheck` | TypeScript en todos los paquetes |
| `pnpm test` | Vitest en todos los paquetes |
| `pnpm build` | Compila los paquetes |
| `pnpm verify` | Lint, tipos, tests y build de todo el monorepo, en ese orden |
| `pnpm test:watch` | Vitest en modo interactivo sobre todos los paquetes |
| `pnpm --filter @anticipate/shared check:package` | Verifica `exports` y tipos del paquete compilado |

## CI

GitHub Actions (`.github/workflows/ci.yml`, permisos de solo lectura) corre `pnpm lint` y luego tipos, tests y build con Turborepo: en un pull request solo sobre lo afectado (`turbo run typecheck test build --affected`, comparando con `main`) y en `main` sobre todo el monorepo. Al final construye `@anticipate/shared` y corre su `check:package` (publint y attw). Un push nuevo a un PR cancela la corrida anterior; en `main` cada commit se verifica completo.

## Estructura

- `packages/shared`: esquemas, reglas de negocio, lector de XML y máquina de estados. Sin código de servidor ni de navegador: su `tsconfig.src.json` compila el código sin tipos de Node ni del DOM (`tsconfig.json` es la del editor y los tests, con modo estricto y tipos de Node) y el test de arquitectura limita qué paquetes importa cada dominio. La fábrica de XML de prueba se publica aparte, en `@anticipate/shared/testing`.
- `packages/config`: presets de TypeScript. La configuración de Biome vive en `biome.json`, en la raíz.
- `apps/`: landing, admin y api (fases siguientes).

## Convenciones

- Código en inglés (identificadores, archivos, modelos); español en mensajes, textos, documentación, comentarios y commits. Glosario en `docs/STACK.md`.
- Las versiones se fijan en el `catalog` de `pnpm-workspace.yaml`; los `package.json` usan `catalog:`. Renovate propone actualizaciones agrupadas los lunes.
- Cada commit pasa por lefthook: Biome sobre lo cambiado y commitlint. Los commits son de una sola línea (Conventional Commits, sin cuerpo ni trailers) y commitlint lo exige con `body-empty` y `footer-empty`.
- Montos con decimal.js y límite `Decimal(14, 2)`.
- Cada app que valide con Zod activa `z.config(z.locales.es())` al arrancar, como respaldo: los esquemas de `shared` ya traen todos sus mensajes en español (lo comprueba `packages/shared/src/spanish-messages.test.ts`) y el locale cubre un esquema propio de la app que olvide el suyo. `shared` nunca llama a `z.config`, que cambia la configuración global del proceso.
- El editor usa Biome como formateador (`.vscode/settings.json`).
- `packages/shared` tiene un test de arquitectura (dirección de dependencias entre dominios y paquetes permitidos por dominio) y una suite dorada. Hoy la suite dorada solo tiene casos semilla generados con la fábrica de prueba (uno de ellos con la forma de un XML real de SUNAT); los XML reales anonimizados se agregan siguiendo `packages/shared/test/golden/README.md`.
