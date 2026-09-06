import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Measurement tests spawn real subprocesses and can be slow on CI.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
