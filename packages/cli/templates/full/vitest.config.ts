import { defineConfig } from 'vitest/config';

// Self-contained test config so this project's tests are found regardless of any parent config.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
});
