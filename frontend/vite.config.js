import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // '' prefix: also read non-VITE_ keys from .env, which stay in this config and never reach the bundle.
  const env = loadEnv(mode, process.cwd(), '');

  // The UI always calls the backend at /api/* (same origin, so no CORS). Locally Vite forwards that to the
  // Express API with the /api prefix stripped; on Amplify a 200 rewrite rule does the same thing.
  const apiProxy = {
    '/api': {
      target: env.API_PROXY_TARGET || 'http://localhost:3000',
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/api/, ''),
    },
  };

  return {
    plugins: [react()],
    server: { port: 5173, proxy: apiProxy },
    preview: { port: 4173, proxy: apiProxy },
  };
});
