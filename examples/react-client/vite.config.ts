import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Frontend :5173 → /agents,/runs istekleri backend :3000'e proxy'lenir (CORS yok).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/agents': 'http://localhost:3000',
      '/runs': 'http://localhost:3000',
    },
  },
});
