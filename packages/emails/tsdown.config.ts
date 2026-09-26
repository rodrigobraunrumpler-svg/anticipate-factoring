import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  // Los `.d.ts` salen de la configuración del código (sin tipos de Node ni tests); `tsconfig.json`
  // es la del editor y de los tests.
  tsconfig: 'tsconfig.src.json',
  format: 'esm',
  platform: 'node',
  // Con `platform: 'node'` tsdown emite `.mjs`/`.d.mts` por defecto; `exports` apunta a `.js`/`.d.ts`.
  fixedExtension: false,
  target: 'es2022',
  // react-email es devDependency: sus componentes (solo los que usan las plantillas) entran en dist,
  // y en tiempo de ejecución quedan @react-email/render, react y react-dom, que son dependencies.
  noExternal: ['react-email'],
  dts: true,
  sourcemap: true,
  clean: true,
})
