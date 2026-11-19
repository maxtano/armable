import { defineConfig, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Two products, two entry points: index.html is the Armable bench, show.html is Armable Shows. In production the
 * server hands /show the second page; in development this does the same for the dev server.
 */
const showEntry = {
  name: 'armable-show-entry',
  configureServer(server: ViteDevServer) {
    server.middlewares.use((req, _res, next) => {
      const [path, query] = (req.url ?? '/').split('?');
      if (/^\/show(\/.*)?$/.test(path)) req.url = `/show.html${query ? `?${query}` : ''}`;
      next();
    });
  },
};

export default defineConfig({
  plugins: [react(), showEntry],
  resolve: { dedupe: ['three'] },
  server: {
    port: 5173, strictPort: true,
    // The hosted app talks to the cloud service. In development it runs on 8787 (npm run serve).
    proxy: { '/api': 'http://localhost:8787', '/live': { target: 'ws://localhost:8787', ws: true }, '/mcp': 'http://localhost:8787', '/authorize': 'http://localhost:8787', '/token': 'http://localhost:8787', '/register': 'http://localhost:8787', '/revoke': 'http://localhost:8787', '/.well-known': 'http://localhost:8787' },
  },
  build: { rollupOptions: { input: { index: 'index.html', show: 'show.html' }, output: { manualChunks: { three: ['three'] } } } },
});
