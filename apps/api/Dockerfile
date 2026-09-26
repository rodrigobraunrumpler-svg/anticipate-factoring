# syntax=docker/dockerfile:1
# Imagen de la API: base → pruner → build, y desde build las dos salidas: migrate (contenedor de un solo
# uso para `prisma migrate deploy`) y runtime (la que corre en el hosting y en `pnpm api:image`).
ARG NODE_IMAGE=node:24.21.0-alpine3.24

# ---------- base: Node y, en las versiones del repositorio, pnpm y turbo (sin corepack) ----------
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Dentro de la imagen no hay .git: lefthook no instala hooks. turbo no envía telemetría.
ENV LEFTHOOK=0
ENV TURBO_TELEMETRY_DISABLED=1
# pnpm sale de `packageManager` y turbo del catálogo: cada versión tiene una sola fuente de verdad.
# Se leen desde /versions y se instalan fuera de /repo: junto al package.json raíz, npm 11 rechaza todo
# comando por su `devEngines` (EBADDEVENGINES). npm 11 bloquea los scripts de instalación globales y pnpm
# los necesita para dejar su binario nativo: `--allow-scripts=pnpm`.
COPY package.json pnpm-workspace.yaml /versions/
RUN npm install -g --allow-scripts=pnpm \
      "pnpm@$(node -p "require('/versions/package.json').packageManager.split('@')[1]")" \
      "turbo@$(sed -n 's/^  turbo: *[~^]*//p' /versions/pnpm-workspace.yaml)"
WORKDIR /repo

# ---------- pruner: el subconjunto del monorepo que necesita la API ----------
FROM base AS pruner
COPY . .
RUN turbo prune @anticipate/api --docker

# ---------- build: instala solo cuando cambian los manifiestos, compila y arma el runtime ----------
FROM base AS build
# out/json trae los package.json, pnpm-lock.yaml y pnpm-workspace.yaml (catálogo, overrides y allowBuilds).
COPY --from=pruner /repo/out/json/ ./
# El `prepare` de la raíz (lefthook install) necesita .git y haría fallar la instalación.
RUN node -e "const fs = require('node:fs'); const p = JSON.parse(fs.readFileSync('package.json', 'utf8')); delete p.scripts.prepare; fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n')"
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ ./
# turbo compila antes shared y emails (^build) y genera el cliente de Prisma (db:generate) en
# src/infrastructure/prisma/generated; `nest build` lo compila dentro de dist. `prisma generate` no se
# conecta a la base: sin variables, prisma.config.ts usa una URL de relleno.
RUN turbo run build --filter=@anticipate/api
# Runtime autocontenido: solo dependencias de producción; shared y emails entran con su dist ("files").
# --no-optional: el lockfile resuelve los peers opcionales de @prisma/client (`prisma` y `typescript`) con
# las devDependencies de la API y los anota como dependencias opcionales; sin esta opción, --prod mete en
# el runtime el CLI de Prisma con su motor de migraciones, Studio y PGlite (unos 285 MB). Hoy lo opcional
# del árbol de producción es eso más los binarios de plataforma de esbuild, pg-cloudflare y
# supports-color, y nada de eso se usa en el runtime. Lo que la API declara se instala igual:
# @nestjs/core encuentra @nestjs/platform-express en node_modules/.pnpm/node_modules, y la prueba de humo
# lo comprueba al arrancar.
# --ignore-scripts: ninguna dependencia de producción necesita script de instalación, y sin su binario
# opcional el postinstall de esbuild (lo trae react-email, que no lo usa al renderizar) lo descargaría
# con npm, fuera del lockfile. Si una dependencia nueva de producción los necesita, se decide aquí.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @anticipate/api deploy --prod --no-optional --ignore-scripts /out/api

# ---------- migrate: `prisma migrate deploy` de un solo uso; nunca en el arranque de la API ----------
FROM build AS migrate
WORKDIR /repo/apps/api
# Con NODE_ENV=production, prisma.config.ts exige DATABASE_DIRECT_URL: nunca se migra por el pooler.
ENV NODE_ENV=production
ENV CHECKPOINT_DISABLE=1
USER node
# El binario de Prisma sin `pnpm exec`: como `node`, pnpm no puede leer el estado que escribió como root.
CMD ["./node_modules/.bin/prisma", "migrate", "deploy"]

# ---------- runtime: sin devDependencies, sin el CLI de Prisma y sin root ----------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
ENV PORT=4000
WORKDIR /app
# Los archivos son de root y el proceso corre como `node`: la API no puede modificar su propio código.
# Sin la condición @anticipate/source, los imports `#/*` de package.json resuelven a ./dist/*. Se copian
# solo los tres caminos que el proceso usa: el lockfile y el pnpm-workspace.yaml que deja `pnpm deploy`
# no le sirven al runtime. COPY conserva los enlaces relativos de node_modules.
COPY --from=build /out/api/package.json ./
COPY --from=build /out/api/node_modules ./node_modules
COPY --from=build /out/api/dist ./dist
USER node
EXPOSE 4000
# Liveness (D47): solo el proceso. Un corte de la base no reinicia el contenedor; eso lo informa la readiness.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/health" || exit 1
# node es el PID 1 y recibe el SIGTERM de `docker stop`: la API deja de programar pasadas, espera la que
# está en curso y cierra el pool (stop_grace_period de 30 s en Compose).
CMD ["node", "dist/main.js"]
