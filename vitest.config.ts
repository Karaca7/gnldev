import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // .tsx dahil: studio-ui view testleri de kök koşuda çalışsın (yalnız .ts iken sessizce atlanıyordu).
    include: ['packages/*/test/**/*.test.{ts,tsx}'],
    environment: 'node',
    // node:sqlite yeni bir Node builtin; vite onu tanımayıp bundle'lamaya çalışıyor → external bırak.
    server: {
      deps: {
        external: [/node:sqlite/, 'node:sqlite'],
      },
    },
  },
});
