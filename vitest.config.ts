import { defineConfig } from 'vitest/config'

// Test harness unified with agent-code's conventions (vitest, colocated
// src/**/*.test.ts) — replaces the earlier ad-hoc `tsx scripts/test-*.ts`
// pattern so headless-library regressions run under the same runner and
// CI shape as the app that consumes them.
export default defineConfig({
  test: {
    // WHY this belongs at the root rather than inside each project: Vitest 4
    // decides whether an explicitly selected project with zero files is an
    // error before it applies that project's nested test options. Repositories
    // are allowed to have an intentionally empty tier while coverage is built
    // out, so every advertised test:* command must still be executable.
    passWithNoTests: true,
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
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // WHY an explicit denominator is mandatory: V8 otherwise reports only
      // modules imported by today's tests, making coverage rise when untested
      // production files simply disappear from the report.
      include: ['src/**/*.ts'],
      // WHY this low baseline is still useful: it is computed against every
      // source file, not only imported files. The gate now prevents backsliding
      // while follow-up behavior tests can ratchet it upward honestly.
      thresholds: { statements: 8, branches: 6, functions: 8, lines: 9 },
    },
  },
})
