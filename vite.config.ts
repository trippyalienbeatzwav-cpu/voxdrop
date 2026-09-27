import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Resolve .env next to this file (not the cwd) so starting from another directory
// never falls back to a port that belongs to another project (5173 = TUNIBEAT).
const envFile = fileURLToPath(new URL('./.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);
const webPort = Number(process.env.WEB_PORT || 5180);
const apiPort = Number(process.env.API_PORT || process.env.PORT || 4180);

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  build: { outDir: '../dist/web', emptyOutDir: true, sourcemap: true },
  server: {
    port: webPort,
    strictPort: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false },
      '/auth': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false },
    },
  },
});
