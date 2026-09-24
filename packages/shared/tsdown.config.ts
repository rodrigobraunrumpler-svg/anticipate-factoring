import { existsSync } from 'node:fs'
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

// Las tareas siguientes van agregando el código fuente de cada dominio; hasta entonces
// tsdown solo debe compilar los que ya existen para no fallar con "entry not found".
const implementedDomains = domains.filter((d) => existsSync(`src/${d}/index.ts`))

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    ...Object.fromEntries(implementedDomains.map((d) => [`${d}/index`, `src/${d}/index.ts`])),
  },
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  dts: true,
  sourcemap: true,
  clean: true,
})
