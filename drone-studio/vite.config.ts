import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: { dedupe: ['three'] },
  server: {
    port: 5173, strictPort: true,
    // The hosted app talks to the cloud service. In development it runs on 8787 (npm run serve).
    proxy: { '/api': 'http://localhost:8787', '/live': { target: 'ws://localhost:8787', ws: true }, '/mcp': 'http://localhost:8787', '/authorize': 'http://localhost:8787', '/token': 'http://localhost:8787', '/register': 'http://localhost:8787', '/revoke': 'http://localhost:8787', '/.well-known': 'http://localhost:8787' },
  },
  build: { rollupOptions: { input: { index: 'index.html' }, output: { manualChunks: { three: ['three'] } } } },
});
