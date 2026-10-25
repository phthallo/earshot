import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    react(),
    {
      // The dev server's SPA fallback swallows /landing/; send it to the static page like nginx would.
      name: 'landing-index',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url === '/landing' || req.url === '/landing/') req.url = '/landing/index.html';
          next();
        });
      },
    },
  ],
  // VITE_* values live in the repo root .env next to the bridge's settings.
  // Absolute: when vite restarts itself after a config change, a relative
  // path resolved against the wrong directory drops every VITE_* value.
  envDir: fileURLToPath(new URL('..', import.meta.url)),
  server: {
    host: true,
    port: 5173,
    // The venue geometry is imported straight from ../data.
    fs: { allow: ['..'] },
  },
});
