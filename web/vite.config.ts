import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const server = process.env.CG_SERVER ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  // `/assets` is reserved for user media served by the engine.
  build: { assetsDir: 'static' },
  server: {
    port: 5173,
    proxy: {
      '/api': server,
      '/assets': server,
      '/fonts': server,
      '/ws': { target: server.replace(/^http/, 'ws'), ws: true },
    },
  },
});
