import { afterAll, describe, expect, it } from 'vitest';
import { ConflictError, MemoryStore, PgStore, type Store } from './store';
import { testPool } from './testkit';

const pool = await testPool('test_store');
const postgres = pool ? await PgStore.open(pool) : undefined;
afterAll(async () => { await postgres?.close(); });

const stores: [string, Store | undefined][] = [['memory', new MemoryStore()], ['Postgres', postgres]];
for (const [name, store] of stores) {
  describe.skipIf(!store)(`store contract: ${name}`, () => {
    const s = store!;
    const a = `acct_a_${name}`, b = `acct_b_${name}`;
    it('writes, reads and counts revisions', async () => {
      const first = await s.put('docs', a, 'one', { n: 1 });
      expect(first).toMatchObject({ rev: 1, data: { n: 1 } });
      expect((await s.put('docs', a, 'one', { n: 2 })).rev).toBe(2);
      expect((await s.get<{ n: number }>('docs', a, 'one'))?.data.n).toBe(2);
      expect(await s.get('docs', a, 'missing')).toBeUndefined();
    });
    it('refuses a write based on an old revision, and a create that would overwrite', async () => {
      await s.put('docs', a, 'cas', { v: 1 }, { expectedRev: 0 });
      await expect(s.put('docs', a, 'cas', { v: 9 }, { expectedRev: 0 })).rejects.toBeInstanceOf(ConflictError);
      await s.put('docs', a, 'cas', { v: 2 }, { expectedRev: 1 });
      const error = await s.put('docs', a, 'cas', { v: 3 }, { expectedRev: 1 }).catch(e => e);
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).current?.rev).toBe(2);
      expect((await s.get<{ v: number }>('docs', a, 'cas'))?.data.v).toBe(2);
    });
    it('lets only one of two simultaneous writers win', async () => {
      await s.put('docs', a, 'race', { v: 0 }, { expectedRev: 0 });
      const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => s.put('docs', a, 'race', { v: i + 1 }, { expectedRev: 1 })));
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect((await s.get('docs', a, 'race'))?.rev).toBe(2);
    });
    it('keeps accounts apart', async () => {
      await s.put('docs', a, 'mine', { owner: 'a' });
      expect(await s.get('docs', b, 'mine')).toBeUndefined();
      expect((await s.list('docs', b)).length).toBe(0);
      await s.put('docs', b, 'mine', { owner: 'b' });
      expect((await s.get<{ owner: string }>('docs', a, 'mine'))?.data.owner).toBe('a');
      await s.delete('docs', b, 'mine');
      expect((await s.get<{ owner: string }>('docs', a, 'mine'))?.data.owner).toBe('a');
    });
    it('lists newest first and appends in order', async () => {
      const c = `acct_c_${name}`;
      for (let i = 0; i < 5; i++) { await s.append('activity', c, { i }); await new Promise(r => setTimeout(r, 2)); }
      const rows = await s.list<{ i: number }>('activity', c, 3);
      expect(rows.map(r => r.data.i)).toEqual([4, 3, 2]);
    });
    it('finds by lookup key and refuses a duplicate key', async () => {
      await s.put('accounts', '', `id1_${name}`, { email: `x@${name}` }, { lookup: `x@${name}`, expectedRev: 0 });
      expect((await s.lookup<{ email: string }>('accounts', `x@${name}`))?.id).toBe(`id1_${name}`);
      expect(await s.lookup('accounts', 'nobody')).toBeUndefined();
      if (name === 'Postgres') await expect(s.put('accounts', '', `id2_${name}`, { email: 'dup' }, { lookup: `x@${name}`, expectedRev: 0 })).rejects.toThrow();
    });
    it('deletes everything an account owns, including rows that only reference it', async () => {
      const d = `acct_d_${name}`;
      await s.put('docs', d, 'x', { n: 1 });
      await s.put('sessions', '', `sess_${name}`, { account: d });
      await s.put('sessions', '', `other_${name}`, { account: 'someone-else' });
      await s.deleteAccount(d);
      expect(await s.get('docs', d, 'x')).toBeUndefined();
      expect(await s.get('sessions', '', `sess_${name}`)).toBeUndefined();
      expect(await s.get('sessions', '', `other_${name}`)).toBeDefined();
    });
    it('round-trips nested data unchanged', async () => {
      const data = { a: [1, 2, { b: null, c: 'é✓', d: 1.5 }], e: { f: true } };
      await s.put('docs', a, 'nested', data);
      expect((await s.get('docs', a, 'nested'))?.data).toEqual(data);
    });
  });
}
