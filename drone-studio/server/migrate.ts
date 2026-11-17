import { readdirSync, readFileSync } from 'node:fs';
import type { Pool } from 'pg';

/**
 * Applies server/migrations/NNN_name.sql in order, each in its own transaction, once.
 * An advisory lock keeps two starting servers from migrating at the same time.
 */
const dir = new URL('./migrations/', import.meta.url);
export function migrations(): { version: number; name: string; sql: string }[] {
  return readdirSync(dir).filter(f => /^\d{3}_[\w-]+\.sql$/.test(f)).sort()
    .map(f => ({ version: Number(f.slice(0, 3)), name: f, sql: readFileSync(new URL(f, dir), 'utf8') }));
}
export async function migrate(pool: Pool): Promise<number[]> {
  const client = await pool.connect();
  const applied: number[] = [];
  try {
    await client.query('select pg_advisory_lock(727274)');
    await client.query('create table if not exists schema_migrations (version integer primary key, name text not null, applied_at timestamptz not null default now())');
    const done = new Set((await client.query<{ version: number }>('select version from schema_migrations')).rows.map(r => r.version));
    for (const m of migrations()) {
      if (done.has(m.version)) continue;
      try {
        await client.query('begin');
        await client.query(m.sql);
        await client.query('insert into schema_migrations (version, name) values ($1, $2)', [m.version, m.name]);
        await client.query('commit');
        applied.push(m.version);
      } catch (error) { await client.query('rollback'); throw new Error(`Migration ${m.name} failed: ${(error as Error).message}`); }
    }
    return applied;
  } finally {
    await client.query('select pg_advisory_unlock(727274)').catch(() => {});
    client.release();
  }
}
