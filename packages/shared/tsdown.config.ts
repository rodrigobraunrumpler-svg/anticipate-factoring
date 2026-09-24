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
  // Fábrica de XML de prueba: fuera del índice raíz, solo por `@anticipate/shared/testing`.
  'testing',
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
