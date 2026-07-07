import { defineConfig } from 'vitest/config'

// Test harness unified with agent-code's conventions (vitest, colocated
// src/**/*.test.ts) — replaces the earlier ad-hoc `tsx scripts/test-*.ts`
// pattern so headless-library regressions run under the same runner and
// CI shape as the app that consumes them.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
