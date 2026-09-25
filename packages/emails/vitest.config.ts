import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { name: 'emails', environment: 'node', include: ['src/**/*.test.ts'] },
})
