import { afterEach, describe, expect, it } from 'vitest';
import { assistant, Browser, callTool, makeAccount, makeServices, openBench, openTab, startApp } from './testkit';
import { TOOLS } from './tools';

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const c of closers.splice(0).reverse()) await c().catch(() => {}); });
const until = async (check: () => boolean | Promise<boolean>, ms = 3000) => { const end = Date.now() + ms; while (!(await check())) { if (Date.now() > end) throw new Error('condition not reached'); await new Promise(r => setTimeout(r, 15)); } };

async function setup() {
  const services = makeServices();
  const account = await makeAccount(services);
  const bench = await openBench(services, account.id);
  closers.push(() => bench.close());
  const call = (name: string, args: Record<string, unknown> = {}) => callTool(services, account.id, name, args);
  await call('read', { ids: ['settings.load'] });
  return { services, account: account.id, bench, call };
}

describe('standing permissions', () => {
  it('run a matching change with no click, read back, and count it', async () => {
    const { services, account, bench, call } = await setup();
    const grant = await services.createGrant(account, { parts: ['tuning'], tests: [], minutes: 15, maxChanges: 3, conditions: [] });
    const p = await call('propose_change', { changes: [{ id: 'param.ATC_RAT_RLL_P', value: 0.12 }], reason: 'Less oscillation.' });
    expect(p.status).toBe('approved');
    const done = await call('wait', { proposal: p.proposal, seconds: 5 });
    expect(done).toMatchObject({ status: 'done', result: { ok: true, changes: [{ id: 'param.ATC_RAT_RLL_P', after: expect.closeTo(0.12, 5) }] } });
    expect(bench.executed).toEqual([p.proposal]);
    expect(bench.sim.params.get('ATC_RAT_RLL_P').value).toBeCloseTo(0.12, 5);
    expect((await services.grants(account))[0]).toMatchObject({ id: grant.id, used: 1 });
    expect((await services.proposal(account, p.proposal)).grant).toBe(grant.id);
  });

  it('do not cover anything outside their parts, a change mixing in parts, or anything that energises the aircraft', async () => {
    const { services, account, bench, call } = await setup();
    await services.createGrant(account, { parts: ['tuning'], tests: ['cal.level'], minutes: 15, maxChanges: 10, conditions: [] });
    expect((await call('propose_change', { changes: [{ id: 'param.FS_THR_ENABLE', value: 'Land' }] })).status).toBe('awaiting_approval');
    expect((await call('propose_change', { changes: [{ id: 'param.ATC_RAT_PIT_P', value: 0.12 }, { id: 'param.RTL_ALT', value: 2000 }] })).status).toBe('awaiting_approval');
    expect((await call('run_test', { id: 'motor.spin', args: { motor: 1 } })).status).toBe('awaiting_approval');
    // Covered by the test list, but it needs "level" and "still", which were not confirmed when the permission was made.
    expect((await call('run_test', { id: 'cal.level' })).status).toBe('awaiting_approval');
    expect(bench.executed).toEqual([]);
    expect(bench.sim.motorTests).toEqual([]);
  });

  it('cover a procedure when the person confirmed its conditions up front', async () => {
    const { services, account, bench, call } = await setup();
    await services.createGrant(account, { parts: [], tests: ['cal.level'], minutes: 5, maxChanges: 1, conditions: ['level', 'still'] });
    const p = await call('run_test', { id: 'cal.level' });
    expect(p.status).toBe('approved');
    expect((await call('wait', { proposal: p.proposal, seconds: 5 })).status).toBe('done');
    expect(bench.sim.params.get('AHRS_TRIM_X').value).toBeCloseTo(0, 4);
    expect((await call('run_test', { id: 'cal.level' })).status).toBe('awaiting_approval');
  });

  it('stop at the change limit, at expiry and when revoked', async () => {
    const { services, account, call } = await setup();
    const g = await services.createGrant(account, { parts: ['tuning'], tests: [], minutes: 15, maxChanges: 2, conditions: [] });
    expect((await call('propose_change', { changes: [{ id: 'param.ATC_RAT_RLL_P', value: 0.12 }, { id: 'param.ATC_RAT_PIT_P', value: 0.12 }, { id: 'param.ATC_RAT_YAW_P', value: 0.2 }] })).status).toBe('awaiting_approval');
    expect((await call('propose_change', { changes: [{ id: 'param.ATC_RAT_RLL_P', value: 0.12 }, { id: 'param.ATC_RAT_PIT_P', value: 0.12 }] })).status).toBe('approved');
    expect((await call('propose_change', { changes: [{ id: 'param.ATC_RAT_YAW_P', value: 0.2 }] })).status).toBe('awaiting_approval');
    expect(await services.grants(account)).toEqual([]);
    const h = await services.createGrant(account, { parts: ['tuning'], tests: [], minutes: 15, maxChanges: 5, conditions: [] });
    await services.revokeGrant(account, h.id);
    expect((await call('propose_change', { changes: [{ id: 'param.ATC_RAT_YAW_P', value: 0.21 }] })).status).toBe('awaiting_approval');
    const k = await services.createGrant(account, { parts: ['tuning'], tests: [], minutes: 1, maxChanges: 5, conditions: [] });
    const row = await services.store.get<any>('grants', account, k.id);
    await services.store.put('grants', account, k.id, { ...row!.data, expiresAt: Date.now() - 1 });
    expect((await call('propose_change', { changes: [{ id: 'param.ATC_RAT_YAW_P', value: 0.22 }] })).status).toBe('awaiting_approval');
    void g;
  });

  it('are tied to the aircraft that was connected, and need one connected to be created', async () => {
    const services = makeServices();
    const account = (await makeAccount(services)).id;
    await expect(services.createGrant(account, { parts: ['tuning'], tests: [], minutes: 5, maxChanges: 2, conditions: [] })).rejects.toMatchObject({ code: 'no_aircraft' });
    const a = await openBench(services, account, 'ardupilot');
    await services.createGrant(account, { parts: ['tuning'], tests: [], minutes: 5, maxChanges: 2, conditions: [] });
    await a.close();
    const b = await openBench(services, account, 'betaflight');
    closers.push(() => b.close());
    await callTool(services, account, 'read', { ids: ['settings.load'] });
    expect((await callTool(services, account, 'propose_change', { changes: [{ id: 'bf.p_roll', value: 50 }] })).status).toBe('awaiting_approval');
  });

  it('cannot be created, widened or used by an assistant', async () => {
    expect(TOOLS.some(t => /grant|permission|allow/i.test(t.name + t.description.replace('allowed', '')))).toBe(false);
    const app = await startApp(); closers.push(() => app.close());
    const browser = new Browser(app.base);
    await browser.signUp();
    const tab = await openTab(browser, 'ardupilot'); closers.push(() => tab.close());
    const grant = await browser.connectAssistant('Claude');
    const claude = await assistant(app.base, grant.access_token!); closers.push(() => claude.close());
    const bearer = { Authorization: `Bearer ${grant.access_token}`, 'x-lucidity': '1', 'content-type': 'application/json' };
    expect((await fetch(`${app.base}/api/grants`, { method: 'POST', headers: bearer, body: JSON.stringify({ parts: ['tuning'], minutes: 60, maxChanges: 50 }) })).status).toBe(401);
    await claude.call('read', { ids: ['settings.load'] });
    // The person allows tuning changes over the real wire; the assistant's change then runs through the tab.
    expect((await browser.post('/api/grants', { parts: ['tuning'], tests: [], minutes: 10, maxChanges: 2, conditions: [] })).status).toBe(200);
    const p = await claude.call('propose_change', { changes: [{ id: 'param.ATC_RAT_RLL_P', value: 0.125 }] });
    expect(p.status).toBe('approved');
    expect((await claude.call('wait', { proposal: p.proposal, seconds: 10 })).status).toBe('done');
    await until(() => tab.events.some(e => e.event === 'execute'));
    expect(tab.sim.params.get('ATC_RAT_RLL_P').value).toBeCloseTo(0.125, 5);
    expect((await browser.get('/api/grants')).json[0]).toMatchObject({ used: 1, parts: ['tuning'] });
    expect((await browser.get('/api/data/proposal_events')).json.some((e: any) => e.grant_id && e.status === 'approved')).toBe(true);
    expect((await browser.post('/api/grants', { parts: ['tuning'], tests: [], minutes: 999, maxChanges: 2 })).json.error.code).toBe('invalid');
  });
});
