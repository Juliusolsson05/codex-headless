import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['testing/ninth-gate-built-runtime.test.mts'],
    fileParallelism: false,
  },
})
