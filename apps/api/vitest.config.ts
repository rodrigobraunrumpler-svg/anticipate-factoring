import { defaultServerConditions } from 'vite'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // `#/*` resuelve a src con la condición `@anticipate/source`. En entorno node la condición va en
  // `ssr.resolve`: `resolve.conditions` en la raíz no llega a los tests. Sin `module`: esa condición
  // de bundlers lleva al AWS SDK a `dist-es`, cuyos imports sin extensión Node no carga; Node en
  // producción tampoco la usa.
  ssr: {
    resolve: {
      conditions: [
        '@anticipate/source',
        ...defaultServerConditions.filter((condition) => condition !== 'module'),
      ],
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'api:unit',
          // prisma/: la guarda de la CLI (cli-guard.ts), que prisma.config.ts no puede exportar.
          include: ['src/**/*.test.ts', 'prisma/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'api:integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['./test/integration/global-setup.ts'],
          // Una sola base anticipate_test: los archivos corren en serie y se trunca entre tests.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
})
