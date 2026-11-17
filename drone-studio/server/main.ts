import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { createApp } from './app';
import { MemoryStore, PgStore, type Store } from './store';

/** Start Lucidity. PUBLIC_URL is the address people type; DATABASE_URL is Postgres. */
const port = Number(process.env.PORT ?? 8787);
const publicUrl = process.env.PUBLIC_URL ?? `http://localhost:${port}`;
let store: Store;
if (process.env.DATABASE_URL) {
  // On AWS the database requires TLS. DATABASE_CA_FILE points at Amazon's certificate bundle so the server is verified.
  const ca = process.env.DATABASE_CA_FILE ? readFileSync(process.env.DATABASE_CA_FILE, 'utf8') : undefined;
  store = await PgStore.open(new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10, ...(ca ? { ssl: { ca, rejectUnauthorized: true } } : {}) }));
  console.log('[lucidity] using Postgres');
} else {
  store = new MemoryStore();
  console.warn('[lucidity] DATABASE_URL is not set. Using memory: everything is lost when this process stops.');
}
// How many proxies sit in front: 1 for a load balancer, 2 for CloudFront plus a load balancer.
const trustProxy = Number(process.env.TRUST_PROXY ?? 1);
const { http, close } = createApp({ store, publicUrl, staticDir: resolve(process.env.STATIC_DIR ?? 'dist'), trustProxy });
http.listen(port, process.env.HOST ?? '0.0.0.0', () => console.log(`[lucidity] ${publicUrl}  (assistants connect to ${new URL('/mcp', publicUrl).href})`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void close().then(() => store.close()).finally(() => process.exit(0)); });
