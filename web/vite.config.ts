import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// During dev the React app runs on :5173 and proxies /api to the Node server
// on :4300, so a single `npm run dev` at the repo root gives a working stack.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: ['dockyard.test', 'minio.test', 'minio-console.test'],
    proxy: {
      '/api': {
        target: process.env.API_PROXY_TARGET || 'http://localhost:4300',
        changeOrigin: true,
      },
    },
  },
});
