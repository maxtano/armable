import { afterEach, describe, expect, it } from 'vitest';
import { Allowance, Disk, GuardedStore, guardTracker, sizeOf } from './limits';
import { Auth } from './auth';
import { MemoryStore } from './store';
import { MemoryTracker } from './tracker';
import { Browser, makeAccount, makeServices, startApp } from './testkit';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });
const failure = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as { code: string; message: string; hint?: string }; } throw new Error('expected a failure'); };

describe('storage per account', () => {
  it('gives a guest a small allowance, frees it on delete, and gives more once saved', async () => {
    const services = makeServices(), auth = new Auth(services.store);
    services.limits.guestBytes = 3000; services.limits.accountBytes = 9000;
    const guest = await auth.guest();
    const a = await services.createDoc(guest.id, 'file', 'a', 'x'.repeat(1000), 'you');
    await services.createDoc(guest.id, 'file', 'b', 'x'.repeat(1000), 'you');
    const full = await failure(services.createDoc(guest.id, 'file', 'c', 'x'.repeat(1000), 'you'));
    expect(full.code).toBe('storage_limit');
    expect(full.hint).toMatch(/Save your bench/);
    await services.deleteDoc(guest.id, a.id);
    await services.createDoc(guest.id, 'file', 'c', 'x'.repeat(1000), 'you');
    await auth.save(guest.id, 'saved@example.test', 'correct horse');
    await services.createDoc(guest.id, 'file', 'd', 'x'.repeat(4000), 'you');
    expect(await services.storageUsed(guest.id)).toBe((await services.docs(guest.id)).reduce((n, r) => n + sizeOf(r.data), 0));
  });

  it('counts edits and undo history, and always lets a document shrink', async () => {
    const services = makeServices(), account = await makeAccount(services);
    services.limits.accountBytes = 5000;
    const doc = await services.createDoc(account.id, 'file', 'notes', 'x'.repeat(1500), 'you');
    // Growing it keeps the old version as history, so the account now holds both.
    const grown = await services.writeDoc(account.id, doc.id, doc.rev, 'y'.repeat(2500), 'you');
    expect((await failure(services.writeDoc(account.id, doc.id, grown.rev, 'z'.repeat(3000), 'you'))).code).toBe('storage_limit');
    const shrunk = await services.writeDoc(account.id, doc.id, grown.rev, 'small', 'you');
    expect(shrunk.rev).toBe(grown.rev + 1);
    await services.undoDoc(account.id, doc.id, 'you');
    expect(await services.storageUsed(account.id)).toBe(sizeOf((await services.doc(account.id, doc.id)).data));
  });

  it('keeps undo history within its limit, but always at least one step', async () => {
    const services = makeServices(), account = await makeAccount(services);
    services.limits.historyBytes = 2500;
    let doc = await services.createDoc(account.id, 'file', 'notes', 'a'.repeat(1000), 'you');
    for (const c of 'bcde') doc = await services.writeDoc(account.id, doc.id, doc.rev, c.repeat(1000), 'you');
    expect(doc.data.history.map(h => (h.content as string)[0])).toEqual(['c', 'd']);
    doc = await services.writeDoc(account.id, doc.id, doc.rev, 'f'.repeat(5000), 'you');
    doc = await services.writeDoc(account.id, doc.id, doc.rev, 'g', 'you');
    expect(doc.data.history.map(h => (h.content as string)[0])).toEqual(['f']);
  });

  it('counts what an account already had the first time it is asked', async () => {
    const store = new MemoryStore(), services = makeServices(store), account = await makeAccount(services);
    await store.put('docs', account.id, 'file_old', { kind: 'file', name: 'old', content: 'x'.repeat(700), updatedBy: 'you', history: [] });
    expect(await services.storageUsed(account.id)).toBeGreaterThan(700);
  });

  it('keeps the newest assistant activity only', async () => {
    const services = makeServices(), account = await makeAccount(services);
    services.limits.activityKept = 10;
    for (let i = 0; i < 100; i++) await services.log(account.id, { who: 'Claude', kind: 'tool', title: `call ${i}` } as never);
    const kept = await services.activity(account.id, 500);
    expect(kept).toHaveLength(10);
    expect(kept[0].title).toBe('call 99');
  });
});

describe('caps across everyone', () => {
  it('counts within a sliding hour', () => {
    let now = 0;
    const allowance = new Allowance(2, 3600_000, () => now);
    expect([allowance.take(), allowance.take(), allowance.take()]).toEqual([true, true, false]);
    now = 3600_001;
    expect(allowance.take()).toBe(true);
  });

  it('turns away new guests, sign-ups and feedback past the hourly cap, with 429', async () => {
    const app = await startApp(undefined, undefined, undefined, { hourly: { guests: 2, signups: 1, feedback: 1 } }); closers.push(() => app.close());
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await new Browser(app.base).post('/api/guest')).status);
    expect(statuses).toEqual([200, 200, 429]);
    const person = new Browser(app.base);
    await person.signUp();
    const late = await new Browser(app.base).post('/api/signup', { email: 'late@example.test', password: 'correct horse' });
    expect(late.status).toBe(429);
    expect(late.json.error.code).toBe('busy');
    expect((await person.post('/api/feedback', { text: 'one' })).status).toBe(200);
    expect((await person.post('/api/feedback', { text: 'two' })).status).toBe(429);
  });
});

describe('when the disk is nearly full', () => {
  it('notices low space, and recovers', async () => {
    let free = 5e9;
    const disk = new Disk('/', 2e9, async () => free);
    expect(await disk.check()).toBe(false);
    free = 1e9;
    expect(await disk.check()).toBe(true);
    free = 3e9;
    expect(await disk.check()).toBe(false);
    expect(await new Disk('/', 2e9, async () => { throw new Error('no statfs'); }).check()).toBe(false);
  });

  it('stops anything that grows, but people can still sign in and use their drone', async () => {
    let low = false;
    const store = new GuardedStore(new MemoryStore(), () => low), services = makeServices(store), auth = new Auth(store);
    const account = await auth.signUp('pilot@example.test', 'correct horse');
    const doc = await services.createDoc(account.id, 'file', 'notes', 'x', 'you');
    low = true;
    expect((await failure(services.createDoc(account.id, 'file', 'more', 'x', 'you'))).code).toBe('storage_full');
    expect((await failure(services.writeDoc(account.id, doc.id, doc.rev, 'y', 'you'))).code).toBe('storage_full');
    expect((await failure(auth.guest())).code).toBe('storage_full');
    // Still working: signing in, sessions, mode changes, deleting, and the assistant log (skipped, not refused).
    expect((await auth.signIn('pilot@example.test', 'correct horse')).id).toBe(account.id);
    expect(await auth.session(await auth.startSession(account.id))).toBe(account.id);
    await services.setMode(account.id, 'propose');
    await services.log(account.id, { who: 'Claude', kind: 'tool', title: 'read' } as never);
    await services.deleteDoc(account.id, doc.id);
    expect(await services.docs(account.id)).toHaveLength(0);
    low = false;
    await services.createDoc(account.id, 'file', 'again', 'x', 'you');
  });

  it('answers 503 with a plain message', async () => {
    const app = await startApp(new GuardedStore(new MemoryStore(), () => true)); closers.push(() => app.close());
    const r = await new Browser(app.base).post('/api/guest');
    expect(r.status).toBe(503);
    expect(r.json.error.message).toMatch(/nearly out of space/);
  });

  it('stops recording telemetry and history, but still knows the aircraft', async () => {
    let low = true;
    const inner = new MemoryTracker(), tracker = guardTracker(inner, () => low);
    const id = await tracker.aircraft('acct', { firmware: 'Betaflight', version: '4.5.0', board: 'X', craftName: 'q' } as never, false);
    await tracker.connection('acct', id, 'connected');
    expect(await tracker.list('aircraft_connections', 'acct')).toHaveLength(0);
    low = false;
    await tracker.connection('acct', id, 'connected');
    expect(await tracker.list('aircraft_connections', 'acct')).toHaveLength(1);
  });
});
