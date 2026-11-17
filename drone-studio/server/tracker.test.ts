import { afterAll, describe, expect, it } from 'vitest';
import { migrate, migrations } from './migrate';
import { PgStore } from './store';
import { assistant, Browser, openTab, startApp, testPool } from './testkit';
import { MemoryTracker, PgTracker, TRACK_TABLES, type Tracker } from './tracker';
import type { Identity, LiveState } from '../src/device/types';

const pool = await testPool('test_tracker');
afterAll(async () => { await pool?.end(); });

const identity: Identity = { stack: 'betaflight', firmware: 'Betaflight', version: '4.5.1', vehicle: 'quad', board: 'SPEEDYBEEF405V4', uid: 'abc123', craftName: 'DEMO5' };
const state: LiveState = { at: 1, linkOk: true, armed: false, mode: 'Disarmed', sensors: {}, armingBlocks: [], messages: [], battery: { voltage: 16.1, current: 1.4, cells: 4 }, gps: { fix: 3, sats: 12 }, rc: { channels: [1500], rssi: 80 }, attitude: { roll: 1.2, pitch: -0.5, yaw: 90 }, cpuLoad: 14 };

describe.skipIf(!pool)('migrations on Postgres', () => {
  it('apply once, in order, and record themselves', async () => {
    expect(await migrate(pool!)).toEqual(migrations().map(m => m.version));
    expect(await migrate(pool!)).toEqual([]);
    const tables = (await pool!.query(`select table_name from information_schema.tables where table_schema = current_schema() order by 1`)).rows.map(r => r.table_name);
    expect(tables).toEqual(expect.arrayContaining([...TRACK_TABLES, 'lucidity_rows', 'schema_migrations', 'tool_usage_daily', 'proposal_outcomes']));
  });
});

for (const [name, make] of [['memory', () => new MemoryTracker()], ['Postgres', () => pool && new PgTracker(pool, e => { throw e; })]] as [string, () => Tracker | undefined][]) {
  describe.skipIf(name === 'Postgres' && !pool)(`tracker contract: ${name}`, () => {
    it('records every kind of event and lists them newest first, per account', async () => {
      if (pool) await migrate(pool);
      const t = make()!;
      const account = `acct_${name}_${Date.now()}`;
      const ac = await t.aircraft(account, identity, true);
      expect(await t.aircraft(account, { ...identity, version: '4.5.2' }, true)).toBe(ac);
      expect(await t.aircraft('someone_else', identity, true)).not.toBe(ac);
      await t.connection(account, ac, 'connected', 'USB 0483:5740');
      await t.telemetry(account, ac, state);
      await t.toolCall({ account, assistant: 'Claude', clientId: 'c1', tool: 'read', input: { ids: ['battery.voltage'] }, ok: true, output: { values: [{ value: 16.1 }] }, durationMs: 12, aircraftId: ac });
      await t.toolCall({ account, assistant: 'Claude', tool: 'propose_change', input: { changes: [{ id: 'bf.p_roll', value: 900 }] }, ok: false, errorCode: 'invalid', output: { error: {} }, durationMs: 3 });
      await t.toolCall({ account, assistant: 'Claude', tool: 'read', input: {}, ok: true, output: { big: 'x'.repeat(20000) }, durationMs: 40 });
      await t.proposal({ proposalId: 'prop_1', account, assistant: 'Claude', kind: 'change', status: 'awaiting_approval', level: 2, needs: ['propsRemoved'], reason: 'why', changes: [{ id: 'esc.3.direction', value: 'normal' }], aircraftId: ac });
      await t.proposal({ proposalId: 'prop_1', account, assistant: 'Claude', kind: 'change', status: 'done', result: { ok: true }, aircraftId: ac });
      await t.settingChange({ account, aircraftId: ac, settingId: 'esc.3.direction', before: 'reversed', requested: 'normal', after: 'normal', ok: true, by: 'Claude', proposalId: 'prop_1' });
      await t.testRun({ account, aircraftId: ac, testId: 'motor.spin', args: { motor: 3 }, ok: null, summary: 'spun', by: 'you' });
      const summary = await t.summary(account);
      expect(summary).toEqual({ aircraft: 1, aircraft_connections: 1, tool_calls: 3, proposal_events: 2, setting_changes: 1, test_runs: 1, telemetry_samples: 1 });
      const calls = await t.list('tool_calls', account);
      expect(calls[0]).toMatchObject({ tool: 'read', output_bytes: expect.any(Number), output: { truncated: true } });
      expect(calls[1]).toMatchObject({ tool: 'propose_change', ok: false, error_code: 'invalid', input: { changes: [{ id: 'bf.p_roll', value: 900 }] } });
      expect((await t.list('aircraft', account))[0]).toMatchObject({ id: ac, stack: 'betaflight', version: '4.5.2', craft_name: 'DEMO5', demo: true });
      expect((await t.list('telemetry_samples', account))[0]).toMatchObject({ voltage: expect.closeTo(16.1, 3), sats: 12, rssi: 80, armed: false });
      expect((await t.list('setting_changes', account))[0]).toMatchObject({ setting_id: 'esc.3.direction', before: 'reversed', after: 'normal', ok: true, by_who: 'Claude' });
      expect(await t.summary('nobody')).toEqual(Object.fromEntries(TRACK_TABLES.map(x => [x, 0])));
      await t.deleteAccount(account);
      expect(Object.values(await t.summary(account)).every(n => n === 0)).toBe(true);
    });
  });
}

describe.skipIf(!pool)('tracking a whole session on Postgres', () => {
  it('records the motor-direction story in tables: aircraft, connection, telemetry, every tool call, proposal states, the change and the test', async () => {
    await migrate(pool!);
    await pool!.query(`truncate ${TRACK_TABLES.join(', ')}, lucidity_rows restart identity cascade`);
    const tracker = new PgTracker(pool!, e => { throw e; });
    const app = await startApp(await PgStore.open(pool!), undefined, tracker);
    const browser = new Browser(app.base);
    await browser.signUp();
    const tab = await openTab(browser, 'ardupilot');
    const grant = await browser.connectAssistant('Claude');
    const claude = await assistant(app.base, grant.access_token!);
    try {
      await claude.call('get_workspace');
      await claude.call('read', { ids: ['settings.load'] });
      await claude.call('run_test', { id: 'battery.check' });
      await claude.call('propose_change', { changes: [{ id: 'param.MOT_SPIN_ARM', value: 0.9 }] });
      const read = await claude.call('run_test', { id: 'esc.read' });
      await tab.approve(read.proposal, ['propsRemoved', 'directUsb', 'batteryConnected']);
      const p = await claude.call('propose_change', { changes: [{ id: 'esc.3.direction', value: 'normal' }], reason: 'Motor 3 turns the wrong way.' });
      await tab.approve(p.proposal, ['propsRemoved', 'directUsb']);
      await claude.call('wait', { proposal: p.proposal });
      await new Promise(r => setTimeout(r, 300));
      const q = async (sql: string) => (await pool!.query(sql)).rows;
      const [aircraft] = await q('select * from aircraft');
      expect(aircraft).toMatchObject({ stack: 'ardupilot', firmware: 'ArduCopter', demo: true });
      expect((await q(`select event from aircraft_connections`)).map(r => r.event)).toContain('connected');
      expect((await q(`select count(*)::int as n from telemetry_samples where aircraft_id = '${aircraft.id}'`))[0].n).toBeGreaterThanOrEqual(1);
      const calls = await q('select tool, ok, error_code, assistant, input, aircraft_id from tool_calls order by at, id');
      expect(calls.map(c => c.tool)).toEqual(['get_workspace', 'read', 'run_test', 'propose_change', 'run_test', 'propose_change', 'wait']);
      expect(calls[3]).toMatchObject({ ok: false, error_code: 'invalid', assistant: 'Claude', input: { changes: [{ id: 'param.MOT_SPIN_ARM', value: 0.9 }] } });
      expect(calls.every(c => c.aircraft_id === aircraft.id)).toBe(true);
      const outcomes = await q(`select final_status, kind from proposal_outcomes order by proposed_at`);
      expect(outcomes.map(o => o.final_status)).toEqual(['done', 'done']);
      expect((await q(`select status from proposal_events where proposal_id = '${p.proposal}' order by id`)).map(r => r.status)).toEqual(['awaiting_approval', 'approved', 'done']);
      expect(await q('select setting_id, before, after, ok, by_who from setting_changes')).toEqual([{ setting_id: 'esc.3.direction', before: 'reversed', after: 'normal', ok: true, by_who: 'Claude' }]);
      expect((await q('select test_id, by_who from test_runs order by id')).map(r => `${r.test_id}:${r.by_who}`)).toEqual(['battery.check:Claude', 'esc.read:Claude']);
      expect((await q(`select tool, calls::int from tool_usage_daily where tool = 'propose_change'`))[0]).toMatchObject({ calls: 2 });
      // The same data, through the API, for the person who owns it only.
      expect((await browser.get('/api/data')).json).toMatchObject({ tool_calls: 7, setting_changes: 1 });
      expect((await browser.get('/api/data/setting_changes')).json[0]).toMatchObject({ setting_id: 'esc.3.direction' });
      const stranger = new Browser(app.base); await stranger.signUp();
      expect((await stranger.get('/api/data/tool_calls')).json).toEqual([]);
      expect((await browser.get('/api/data/lucidity_rows')).status).toBe(404);
      await browser.request('DELETE', '/api/account');
      expect((await q(`select count(*)::int as n from tool_calls`))[0].n).toBe(0);
    } finally { await claude.close(); await tab.close(); await app.close(); }
  });
});
