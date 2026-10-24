import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    // The venue geometry is imported straight from ../data.
    fs: { allow: ['..'] },
  },
});
