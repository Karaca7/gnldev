import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Includes .tsx: so studio-ui view tests also run in the root run (they were silently skipped when only .ts).
    include: ['packages/*/test/**/*.test.{ts,tsx}'],
    environment: 'node',
    // node:sqlite is a new Node builtin; vite doesn't recognize it and tries to bundle it → leave it external.
    server: {
      deps: {
        external: [/node:sqlite/, 'node:sqlite'],
      },
    },
  },
});
