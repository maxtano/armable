import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { createApp } from './app';
import { Disk, GuardedStore, guardTracker } from './limits';
import { MemoryStore, PgStore, type Store } from './store';
import { PgTracker, type Tracker } from './tracker';

/** Start Armable. PUBLIC_URL is the address people type; DATABASE_URL is Postgres. */
const port = Number(process.env.PORT ?? 8787);
const publicUrl = process.env.PUBLIC_URL ?? `http://localhost:${port}`;
let store: Store;
let tracker: Tracker | undefined;
if (process.env.DATABASE_URL) {
  // A managed Postgres that requires TLS: point DATABASE_CA_FILE at its CA bundle and the certificate is verified.
  // The Google Cloud server in infra/gcp runs Postgres beside the app, over the Docker network, so it sets neither.
  const ca = process.env.DATABASE_CA_FILE ? readFileSync(process.env.DATABASE_CA_FILE, 'utf8') : undefined;
  const pgStore = await PgStore.open(new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10, ...(ca ? { ssl: { ca, rejectUnauthorized: true } } : {}) }));
  store = pgStore;
  tracker = new PgTracker(pgStore.db);
  console.log('[armable] using Postgres');
} else {
  store = new MemoryStore();
  console.warn('[armable] DATABASE_URL is not set. Using memory: everything is lost when this process stops.');
}
// Below 2 GB free on the disk that holds the database, stop saving anything new instead of filling it.
// STORAGE_PATH is any path on that disk; in Docker, / is on the host's disk.
const disk = new Disk(process.env.STORAGE_PATH ?? '/').start();
store = new GuardedStore(store, () => disk.low);
if (tracker) tracker = guardTracker(tracker, () => disk.low);
// How many proxies sit in front: 1 for a load balancer, 2 for CloudFront plus a load balancer.
const trustProxy = Number(process.env.TRUST_PROXY ?? 1);
const google = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET ? { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET } : undefined;
const admins = (process.env.ADMIN_EMAILS ?? '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
const { http, close, auth, services } = createApp({ store, publicUrl, staticDir: resolve(process.env.STATIC_DIR ?? 'dist'), trustProxy, tracker, google, feedbackWebhook: process.env.FEEDBACK_WEBHOOK_URL, admins });
// Guest benches nobody has opened for 30 days are deleted, once a day.
const purge = async () => { try { const gone = await auth.purgeGuests(30); for (const id of gone) await services.forgetRatings(id); if (gone.length) console.log(`[armable] removed ${gone.length} unused guest benches`); } catch (error) { console.error('[armable] guest cleanup failed', error); } };
setTimeout(() => void purge(), 60_000).unref();
setInterval(() => void purge(), 86400_000).unref();
http.listen(port, process.env.HOST ?? '0.0.0.0', () => console.log(`[armable] ${publicUrl}  (assistants connect to ${new URL('/mcp', publicUrl).href})`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void close().then(() => store.close()).finally(() => process.exit(0)); });
