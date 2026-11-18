import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The Armable panel (src/panel): one script and one stylesheet, which the server inlines into a single page, as
 * MCP Apps require. Built after the app, into dist/panel.
 */
export default defineConfig({
  plugins: [react()],
  // The drawing imports the app's controller only to select a part; the panel has a small stand-in.
  resolve: { alias: [{ find: /^\.\/controller$/, replacement: fileURLToPath(new URL('./src/panel/controller.ts', import.meta.url)) }] },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: 'dist/panel', emptyOutDir: true, cssCodeSplit: false, copyPublicDir: false,
    rollupOptions: { input: 'src/panel/main.tsx', output: { format: 'iife', entryFileNames: 'panel.js', assetFileNames: 'panel.[ext]', inlineDynamicImports: true } },
  },
});
