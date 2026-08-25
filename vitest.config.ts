import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Includes .tsx: so studio-ui view tests also run in the root run (they were silently skipped when only .ts).
    include: ['packages/*/test/**/*.test.{ts,tsx}'],
    environment: 'node',
    /**
     * Vitest's default is 5s, which this suite exceeds under load rather than because anything is slow.
     * Measured twice on one machine: `pricing-command.test.ts` timed out during a full run and passed
     * in 829ms on its own; the full run that failed took 149s against a usual ~50s, so the machine was
     * contended, not the test. CI has never run against this repository, and GitHub's shared runners
     * are two cores — the ones most likely to reproduce it.
     *
     * A raised ceiling is not a slower suite: a test that passes in 800ms still takes 800ms. What it
     * changes is which failures are real. A timeout that fires on contention is a false red, and a
     * false red on the FIRST CI run of a public repository is the one that gets read as "the project
     * does not build".
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // node:sqlite is a new Node builtin; vite doesn't recognize it and tries to bundle it → leave it external.
    server: {
      deps: {
        external: [/node:sqlite/, 'node:sqlite'],
      },
    },
  },
});
