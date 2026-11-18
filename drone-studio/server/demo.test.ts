import { afterEach, describe, expect, it } from 'vitest';
import { CloudDemos } from './demo';
import { callTool, FAST, makeAccount, makeServices, openBench } from './testkit';

const demos: CloudDemos[] = [];
afterEach(() => { while (demos.length) demos.pop()!.close(); });
const make = (services = makeServices(), limits = { max: 5, idleMs: 60_000, maxMs: 120_000 }, now = Date.now) => {
  const d = new CloudDemos(services, limits, now, FAST); demos.push(d); return { services, demos: d };
};
const failure = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as { code: string }; } throw new Error('expected a failure'); };

describe('demo drones on the server', () => {
  it('serve an account exactly as a tab with a drone does: the assistant reads, proposes, and the panel approves', async () => {
    const { services, demos } = make();
    const account = await makeAccount(services);
    await demos.start(account.id);
    expect((await callTool(services, account.id, 'get_workspace')).aircraft).toMatchObject({ connected: true, demo: true, firmware: expect.stringContaining('Betaflight') });
    await callTool(services, account.id, 'read', { ids: ['settings.load'] });
    // The demo's fault: the receiver speaks CRSF, Betaflight is set to SBUS.
    const p = await callTool(services, account.id, 'propose_change', { changes: [{ id: 'bf.serialrx_provider', value: 'CRSF' }] });
    expect(p.status).toBe('awaiting_approval');
    const outcome = await demos.approve(account.id, p.proposal, []);
    expect(outcome.ok).toBe(true);
    expect((await services.proposal(account.id, p.proposal)).status).toBe('done');
  });

  it('never approves anything but its own demo drone', async () => {
    const { services, demos } = make();
    const account = await makeAccount(services);
    const bench = await openBench(services, account.id, 'betaflight');
    await callTool(services, account.id, 'read', { ids: ['settings.load'] });
    const p = await callTool(services, account.id, 'propose_change', { changes: [{ id: 'bf.serialrx_provider', value: 'SBUS' }] });
    expect((await failure(demos.approve(account.id, p.proposal, []))).code).toBe('not_demo');
    // And it won't start a demo over a drone already connected in a tab.
    expect((await failure(demos.start(account.id))).code).toBe('tab_open');
    bench.runtime.disconnect();
  });

  it('runs a few at once, and stops ones left unused or running too long', async () => {
    let now = 1_000_000;
    const { services, demos } = make(undefined, { max: 2, idleMs: 60_000, maxMs: 120_000 }, () => now);
    const [a, b, c] = [await makeAccount(services, 'a@x.test'), await makeAccount(services, 'b@x.test'), await makeAccount(services, 'c@x.test')];
    await demos.start(a.id); await demos.start(b.id);
    expect((await failure(demos.start(c.id))).code).toBe('busy');
    now += 50_000; demos.touch(a.id);
    now += 20_000; demos.sweep();
    expect([demos.has(a.id), demos.has(b.id)]).toEqual([true, false]);
    expect(services.hub(b.id).benchTab()).toBeUndefined();
    now += 60_000; demos.touch(a.id); demos.sweep();
    expect(demos.has(a.id)).toBe(false);
    await demos.start(c.id);
    expect(demos.has(c.id)).toBe(true);
  });
});
