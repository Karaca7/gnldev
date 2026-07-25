import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base: './' → relative asset paths → resolves correctly with the <base href> injected under the
// @gnldev/studio mount prefix (e.g. /studio) (mount-path agnostic SPA).
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: {
    // For dev: proxy the API to the consumer server (GNL_STUDIO_API → e.g. http://localhost:3000).
    proxy: { '/api': { target: process.env.GNL_STUDIO_API ?? 'http://localhost:3000', changeOrigin: true } },
  },
});
