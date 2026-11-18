import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { migrate } from './migrate';

/**
 * Storage. Every row belongs to one account and carries a revision. A write can name the revision it was
 * based on; if someone else wrote first, it is refused. Postgres in production, memory in tests: same contract.
 */
export interface Row<T = unknown> { collection: string; account: string; id: string; rev: number; data: T; lookup?: string; updatedAt: number }
export class ConflictError extends Error { constructor(readonly current: Row | undefined) { super('The row changed since it was read.'); } }
export interface PutOptions { /** Refuse unless the stored revision equals this. 0 means "must not exist yet". */ expectedRev?: number; lookup?: string }
export interface Store {
  get<T>(collection: string, account: string, id: string): Promise<Row<T> | undefined>;
  /** Newest first. */
  list<T>(collection: string, account: string, limit?: number): Promise<Row<T>[]>;
  put<T>(collection: string, account: string, id: string, data: T, options?: PutOptions): Promise<Row<T>>;
  delete(collection: string, account: string, id: string): Promise<void>;
  /** Add a row with a time-ordered id. */
  append<T>(collection: string, account: string, data: T): Promise<Row<T>>;
  /** Find one row by its lookup key, across accounts. For sign-in by email and tokens by hash only. */
  lookup<T>(collection: string, key: string): Promise<Row<T> | undefined>;
  deleteAccount(account: string): Promise<void>;
  close(): Promise<void>;
}
let counter = 0;
export const newId = (bytes = 9) => randomBytes(bytes).toString('base64url');
const orderedId = () => `${Date.now().toString(36).padStart(9, '0')}${(counter++ % 1296).toString(36).padStart(2, '0')}${newId(4)}`;

export class MemoryStore implements Store {
  private rows = new Map<string, Row>();
  private key = (c: string, a: string, i: string) => `${c}\u0000${a}\u0000${i}`;
  async get<T>(c: string, a: string, i: string) { const row = this.rows.get(this.key(c, a, i)); return row ? structuredClone(row) as Row<T> : undefined; }
  async list<T>(c: string, a: string, limit = 100) {
    return [...this.rows.values()].filter(r => r.collection === c && r.account === a).sort((x, y) => y.updatedAt - x.updatedAt || (y.id > x.id ? 1 : -1)).slice(0, limit).map(r => structuredClone(r) as Row<T>);
  }
  async put<T>(c: string, a: string, i: string, data: T, options: PutOptions = {}) {
    const key = this.key(c, a, i), current = this.rows.get(key);
    if (options.expectedRev !== undefined && (current?.rev ?? 0) !== options.expectedRev) throw new ConflictError(current && structuredClone(current));
    const row: Row<T> = { collection: c, account: a, id: i, rev: (current?.rev ?? 0) + 1, data: structuredClone(data), lookup: options.lookup ?? current?.lookup, updatedAt: Date.now() };
    this.rows.set(key, row);
    return structuredClone(row);
  }
  async delete(c: string, a: string, i: string) { this.rows.delete(this.key(c, a, i)); }
  async append<T>(c: string, a: string, data: T) { return this.put(c, a, orderedId(), data); }
  async lookup<T>(c: string, key: string) { const row = [...this.rows.values()].find(r => r.collection === c && r.lookup === key); return row ? structuredClone(row) as Row<T> : undefined; }
  async deleteAccount(account: string) { for (const [key, row] of this.rows) if (row.account === account || (row.data as { account?: string } | null)?.account === account) this.rows.delete(key); }
  async close() {}
}


type Db = { collection: string; account: string; id: string; rev: number; data: unknown; lookup: string | null; updated_at: string };
const toRow = <T>(r: Db): Row<T> => ({ collection: r.collection, account: r.account, id: r.id, rev: r.rev, data: r.data as T, lookup: r.lookup ?? undefined, updatedAt: Number(r.updated_at) });

export class PgStore implements Store {
  private constructor(private pool: Pool) {}
  static async open(pool: Pool) { await migrate(pool); return new PgStore(pool); }
  get db() { return this.pool; }
  async get<T>(c: string, a: string, i: string) {
    const { rows } = await this.pool.query<Db>('select * from armable_rows where collection=$1 and account=$2 and id=$3', [c, a, i]);
    return rows[0] ? toRow<T>(rows[0]) : undefined;
  }
  async list<T>(c: string, a: string, limit = 100) {
    const { rows } = await this.pool.query<Db>('select * from armable_rows where collection=$1 and account=$2 order by updated_at desc, id desc limit $3', [c, a, limit]);
    return rows.map(r => toRow<T>(r));
  }
  async put<T>(c: string, a: string, i: string, data: T, options: PutOptions = {}) {
    const now = Date.now(), json = JSON.stringify(data);
    if (options.expectedRev === undefined) {
      const { rows } = await this.pool.query<Db>(
        `insert into armable_rows (collection, account, id, rev, data, lookup, updated_at) values ($1,$2,$3,1,$4::jsonb,$5,$6)
         on conflict (collection, account, id) do update set rev = armable_rows.rev + 1, data = excluded.data, lookup = coalesce(excluded.lookup, armable_rows.lookup), updated_at = excluded.updated_at returning *`, [c, a, i, json, options.lookup ?? null, now]);
      return toRow<T>(rows[0]);
    }
    const { rows } = options.expectedRev === 0
      ? await this.pool.query<Db>('insert into armable_rows (collection, account, id, rev, data, lookup, updated_at) values ($1,$2,$3,1,$4::jsonb,$5,$6) on conflict do nothing returning *', [c, a, i, json, options.lookup ?? null, now])
      : await this.pool.query<Db>('update armable_rows set rev = rev + 1, data = $4::jsonb, lookup = coalesce($5, lookup), updated_at = $6 where collection=$1 and account=$2 and id=$3 and rev=$7 returning *', [c, a, i, json, options.lookup ?? null, now, options.expectedRev]);
    if (!rows[0]) throw new ConflictError(await this.get(c, a, i));
    return toRow<T>(rows[0]);
  }
  async delete(c: string, a: string, i: string) { await this.pool.query('delete from armable_rows where collection=$1 and account=$2 and id=$3', [c, a, i]); }
  async append<T>(c: string, a: string, data: T) { return this.put(c, a, orderedId(), data); }
  async lookup<T>(c: string, key: string) {
    const { rows } = await this.pool.query<Db>('select * from armable_rows where collection=$1 and lookup=$2', [c, key]);
    return rows[0] ? toRow<T>(rows[0]) : undefined;
  }
  async deleteAccount(account: string) { await this.pool.query(`delete from armable_rows where account=$1 or data->>'account'=$1`, [account]); }
  async close() { await this.pool.end(); }
}
