import { defineConfig } from 'vitest/config'

// Test harness unified with agent-code's conventions (vitest, colocated
// src/**/*.test.ts) — replaces the earlier ad-hoc `tsx scripts/test-*.ts`
// pattern so headless-library regressions run under the same runner and
// CI shape as the app that consumes them.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'core',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.system.test.ts', 'src/**/*.live.test.ts'],
        },
      },
      {
        test: {
          name: 'system',
          environment: 'node',
          include: ['src/**/*.system.test.ts'],
          passWithNoTests: true,
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
    },
  },
})
