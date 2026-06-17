import { defineConfig } from 'vite';

// In dev the Vite server (5173) proxies the data plane to the always-on backend
// (8787) so the client always talks to a same-origin /api/*. In production the
// backend serves the built client itself, so no proxy is involved.
const API_TARGET = process.env.API_TARGET || 'http://127.0.0.1:8787';

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
    host: '127.0.0.1',
  },
  build: {
    target: 'es2022',
  },
});
