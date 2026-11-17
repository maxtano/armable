import { afterEach, describe, expect, it } from 'vitest';
import { PgStore } from './store';
import { assistant, Browser, openTab, startApp, testPool } from './testkit';

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close().catch(() => {}); });
async function world(stack?: 'ardupilot' | 'betaflight', simOptions: Record<string, unknown> = {}) {
  const app = await startApp();
  closers.push(() => app.close());
  const browser = new Browser(app.base);
  await browser.signUp();
  const tab = stack ? await openTab(browser, stack, simOptions) : undefined;
  if (tab) closers.push(() => tab.close());
  const grant = await browser.connectAssistant('Claude');
  const claude = await assistant(app.base, grant.access_token!);
  closers.push(() => claude.close());
  return { app, browser, tab: tab!, grant, claude };
}
const until = async (check: () => boolean | Promise<boolean>, ms = 3000) => { const end = Date.now() + ms; while (!(await check())) { if (Date.now() > end) throw new Error('condition not reached'); await new Promise(r => setTimeout(r, 15)); } };

describe('signing in', () => {
  it('creates an account, signs out and back in, and rejects a wrong password', async () => {
    const app = await startApp(); closers.push(() => app.close());
    const b = new Browser(app.base);
    expect((await b.get('/api/me')).json).toEqual({ signedIn: false });
    const email = await b.signUp();
    expect((await b.get('/api/me')).json).toMatchObject({ signedIn: true, email, mode: 'propose', mcpUrl: `${app.base}/mcp`, assistants: [] });
    await b.post('/api/logout');
    expect((await b.get('/api/docs')).status).toBe(401);
    expect((await b.post('/api/login', { email, password: 'wrong wrong' })).json.error.message).toBe('That email and password do not match.');
    expect((await b.post('/api/login', { email: 'nobody@example.test', password: 'wrong wrong' })).json.error.message).toBe('That email and password do not match.');
    expect((await b.post('/api/login', { email, password: 'correct horse' })).status).toBe(200);
    expect((await b.get('/api/docs')).json).toEqual([]);
    expect((await new Browser(app.base).post('/api/signup', { email, password: 'another one' })).json.error.code).toBe('exists');
    expect((await new Browser(app.base).post('/api/signup', { email: 'x@example.test', password: 'short' })).json.error.code).toBe('invalid');
  });
  it('never stores the password or the session token in the clear', async () => {
    const app = await startApp(); closers.push(() => app.close());
    const b = new Browser(app.base);
    const email = await b.signUp(undefined, 'a very secret phrase');
    const dump = JSON.stringify([await app.store.list('accounts', ''), await app.store.list('sessions', '')]);
    expect(dump).toContain(email);
    expect(dump).not.toContain('a very secret phrase');
    expect(dump).not.toContain(b.cookie.split('=')[1]);
  });
  it('refuses a state-changing request that lacks the header a foreign site cannot send', async () => {
    const app = await startApp(); closers.push(() => app.close());
    const b = new Browser(app.base);
    await b.signUp();
    const r = await fetch(`${app.base}/api/mode`, { method: 'PUT', headers: { cookie: b.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'off' }) });
    expect(r.status).toBe(403);
    expect((await b.get('/api/me')).json.mode).toBe('propose');
  });
});

describe('connecting an assistant', () => {
  it('publishes the discovery documents an assistant app looks for', async () => {
    const app = await startApp(); closers.push(() => app.close());
    const unauthorised = await fetch(`${app.base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(unauthorised.status).toBe(401);
    expect(unauthorised.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource/mcp');
    const resource = await (await fetch(`${app.base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(resource).toMatchObject({ resource: `${app.base}/mcp`, scopes_supported: ['observe', 'design', 'propose'] });
    const server = await (await fetch(`${app.base}/.well-known/oauth-authorization-server`)).json();
    expect(server).toMatchObject({ code_challenge_methods_supported: ['S256'] });
    expect(server.registration_endpoint).toBe(`${app.base}/register`);
  });
  it('sends a signed-out person to sign in first, then back to the same request', async () => {
    const app = await startApp(); closers.push(() => app.close());
    const b = new Browser(app.base);
    const attempt = await b.connectAssistant('Claude');
    expect(attempt.started!.location).toMatch(/^\/\?next=%2Fauthorize/);
    expect(attempt.access_token).toBeUndefined();
  });
  it('shows who is asking, issues tokens on Allow, and nothing on Decline', async () => {
    const app = await startApp(); closers.push(() => app.close());
    const b = new Browser(app.base);
    await b.signUp();
    const declined = await b.connectAssistant('Nosy', 'observe', false);
    expect(declined.denied).toBe('access_denied');
    const grant = await b.connectAssistant('Claude');
    expect(grant.details).toEqual({ client: 'Claude', scopes: ['observe', 'design', 'propose'], redirectHost: 'localhost:9' });
    expect(grant.access_token).toBeTruthy();
    expect((await b.get('/api/me')).json.assistants).toMatchObject([{ name: 'Claude', scopes: ['observe', 'design', 'propose'] }]);
    const reuse = await fetch(`${app.base}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: grant.code!, code_verifier: grant.verifier!, client_id: grant.clientId, redirect_uri: grant.redirect! }) });
    expect(reuse.status).toBe(400);
  });
  it('rejects a code presented with the wrong PKCE verifier', async () => {
    const app = await startApp(); closers.push(() => app.close());
    const b = new Browser(app.base);
    await b.signUp();
    const originalFetch = globalThis.fetch;
    // Tamper with the verifier on its way to /token.
    globalThis.fetch = ((input: any, init?: any) => String(input).endsWith('/token') ? originalFetch(input, { ...init, body: new URLSearchParams([...new URLSearchParams(init.body).entries()].map(([k, v]) => [k, k === 'code_verifier' ? 'x'.repeat(43) : v])) }) : originalFetch(input, init)) as typeof fetch;
    try { expect((await b.connectAssistant('Claude')).access_token).toBeUndefined(); } finally { globalThis.fetch = originalFetch; }
  });
  it('rotates refresh tokens and stops everything the moment the person disconnects the assistant', async () => {
    const { app, browser, grant, claude } = await world();
    const refresh = (token: string) => fetch(`${app.base}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token, client_id: grant.clientId }) });
    const next = await (await refresh(grant.refresh_token!)).json();
    expect(next.access_token).toBeTruthy();
    expect((await refresh(grant.refresh_token!)).status).toBe(400);
    expect((await claude.call('get_workspace')).lucidityOpen).toBe(false);
    await browser.request('DELETE', `/api/assistants/${grant.clientId}`);
    await expect(claude.call('get_workspace')).rejects.toThrow();
    expect((await refresh(next.refresh_token)).status).toBe(400);
    expect((await browser.get('/api/me')).json.assistants).toEqual([]);
  });
});

describe('an assistant over MCP, a person in a tab, a simulated drone on the bench', () => {
  it('lists eleven tools with typed inputs and behaviour hints, plus playbook prompts', async () => {
    const { claude } = await world();
    const { tools } = await claude.client.listTools();
    expect(tools.map(t => t.name)).toEqual(['get_workspace', 'find', 'read', 'run_test', 'propose_change', 'wait', 'edit', 'undo', 'show', 'capture_view', 'stop']);
    expect(tools.find(t => t.name === 'read')!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(tools.find(t => t.name === 'propose_change')!.inputSchema.required).toEqual(['changes']);
    expect(claude.client.getInstructions()).toContain('Start with get_workspace');
    expect((await claude.client.listPrompts()).prompts.map(p => p.name)).toContain('motor_wrong_way');
    expect(JSON.stringify(tools).length).toBeLessThan(12000);
  });

  it('runs the whole motor-direction story across the real wire', async () => {
    const { claude, tab, browser } = await world('ardupilot');
    tab.send({ type: 'focus', focus: { route: 'drone', part: 'motors', selection: { motor: 3 } } });
    await until(async () => (await claude.call('get_workspace')).aircraft.connected === true);
    const w = await claude.call('get_workspace');
    expect(w).toMatchObject({ benchTab: true, aircraft: { stack: 'ardupilot', demo: true }, lookingAt: { part: 'motors', selection: { motor: 3 } } });
    expect((await claude.call('find', { query: 'motor spins the wrong way' })).hits[0].id).toBe('play.motor-wrong-way');
    await claude.call('read', { ids: ['settings.load'] });

    const read = await claude.call('run_test', { id: 'esc.read' });
    await until(() => tab.events.some(e => e.event === 'proposal' && e.data.id === read.proposal));
    await tab.approve(read.proposal, ['propsRemoved', 'directUsb', 'batteryConnected']);
    expect((await claude.call('wait', { proposal: read.proposal })).status).toBe('done');
    expect((await claude.call('read', { ids: ['esc.3.direction'] })).values[0].value).toBe('reversed');

    const proposal = await claude.call('propose_change', { changes: [{ id: 'esc.3.direction', value: 'normal' }], reason: 'Motor 3 turns the wrong way.' });
    expect(proposal.changes).toEqual([{ id: 'esc.3.direction', from: 'reversed', to: 'normal' }]);
    await until(() => tab.events.some(e => e.event === 'proposal' && e.data.id === proposal.proposal));
    const card = tab.events.find(e => e.event === 'proposal' && e.data.id === proposal.proposal)!.data;
    expect(card).toMatchObject({ by: 'Claude', reason: 'Motor 3 turns the wrong way.', needs: ['propsRemoved', 'directUsb'], status: 'awaiting_approval' });
    const waiting = claude.call('wait', { proposal: proposal.proposal, seconds: 20 });
    await tab.approve(proposal.proposal, ['propsRemoved', 'directUsb']);
    expect(await waiting).toMatchObject({ status: 'done', result: { ok: true, changes: [{ before: 'reversed', after: 'normal', ok: true }] } });
    expect(tab.sim.escBank.images[2][0x1a0b]).toBe(1);

    const activity = (await browser.get('/api/activity')).json as { who: string; kind: string; title: string }[];
    expect(activity.some(a => a.who === 'Claude' && a.kind === 'proposal')).toBe(true);
    expect(activity.some(a => a.who === 'you' && a.kind === 'change' && a.title === "Approved Claude's change")).toBe(true);
    expect(tab.events.some(e => e.event === 'activity')).toBe(true);
  });

  it('does the same on Betaflight, including the restart after saving', async () => {
    const { claude, tab } = await world('betaflight');
    await until(async () => (await claude.call('get_workspace')).aircraft.connected === true);
    await claude.call('read', { ids: ['settings.load'] });
    const p = await claude.call('propose_change', { changes: [{ id: 'bf.vtx_power', value: 3 }] });
    await tab.approve(p.proposal);
    const done = await claude.call('wait', { proposal: p.proposal });
    expect(done.result.changes[0]).toMatchObject({ ok: true, after: 3, note: 'Saved and confirmed after the restart.' });
    expect(tab.sim.settings.vtx_power.value).toBe('3');
    await until(async () => (await claude.call('read', { ids: ['bf.vtx_power'] })).values[0].value === 3);
  });

  it('gives an assistant no route to approve: not the decision route, not the result route, not the live channel', async () => {
    const { app, claude, tab, grant } = await world('ardupilot');
    await claude.call('read', { ids: ['settings.load'] });
    const p = await claude.call('propose_change', { changes: [{ id: 'param.RTL_ALT', value: 2000 }] });
    const bearer = { Authorization: `Bearer ${grant.access_token}`, 'x-lucidity': '1', 'content-type': 'application/json' };
    for (const [path, body] of [[`/api/proposals/${p.proposal}/decision`, { approve: true }], [`/api/proposals/${p.proposal}/result`, { ok: true, summary: 'done' }], ['/api/mode', { mode: 'propose' }]] as const)
      expect((await fetch(app.base + path, { method: path === '/api/mode' ? 'PUT' : 'POST', headers: bearer, body: JSON.stringify(body) })).status).toBe(401);
    // The token is not a session cookie either.
    expect((await fetch(`${app.base}/api/proposals/${p.proposal}/decision`, { method: 'POST', headers: { cookie: `lucidity_session=${grant.access_token}`, 'x-lucidity': '1', 'content-type': 'application/json' }, body: '{"approve":true}' })).status).toBe(401);
    const { WebSocket } = await import('ws');
    const refused = await new Promise<string>(resolve => { const ws = new WebSocket(app.base.replace('http', 'ws') + '/live', { headers: { Authorization: `Bearer ${grant.access_token}`, cookie: `lucidity_session=${grant.access_token}` } }); ws.once('open', () => resolve('open')); ws.once('error', () => resolve('refused')); });
    expect(refused).toBe('refused');
    expect((await claude.call('wait', { proposal: p.proposal, seconds: 1 })).status).toBe('awaiting_approval');
    expect(tab.sim.params.get('RTL_ALT').value).toBe(1500);
  });

  it('limits an assistant to the permissions the person granted', async () => {
    const { app, browser, tab } = await world('ardupilot');
    void tab;
    const narrow = await browser.connectAssistant('Reader', 'observe');
    const reader = await assistant(app.base, narrow.access_token!, 'Reader');
    closers.push(() => reader.close());
    await reader.call('read', { ids: ['settings.load'] });
    expect((await reader.call('read', { ids: ['battery.voltage'] })).values[0].value).toBe(15.8);
    expect((await reader.call('propose_change', { changes: [{ id: 'param.RTL_ALT', value: 2000 }] })).error.code).toBe('not_allowed');
    expect((await reader.call('edit', { create: { kind: 'file', name: 'n' }, content: 'x' })).error.code).toBe('not_allowed');
    expect((await reader.call('run_test', { id: 'motor.spin', args: { motor: 1 } })).error.code).toBe('not_allowed');
  });

  it('shows an assistant\'s edit in the open tab at once, and keeps one shared history', async () => {
    const { claude, tab, browser } = await world('ardupilot');
    const created = (await browser.post('/api/docs', { kind: 'file', name: 'checklist', content: 'props off' })).json;
    const edited = await claude.call('edit', { document: created.id, baseRevision: 1, content: 'props off\nbattery in' });
    expect(edited.revision).toBe(2);
    await until(() => tab.events.some(e => e.event === 'document' && e.data.id === created.id && e.data.rev === 2 && e.data.by === 'Claude'));
    const stale = await browser.request('PUT', `/api/docs/${created.id}`, { baseRevision: 1, content: 'mine' });
    expect(stale.status).toBe(409);
    expect(stale.json.error).toMatchObject({ code: 'stale', currentRevision: 2, lastEditedBy: 'Claude' });
    expect((await browser.post(`/api/docs/${created.id}/undo`)).json.error.code).toBe('not_yours');
    await claude.call('undo', { document: created.id });
    expect((await browser.get(`/api/docs/${created.id}`)).json).toMatchObject({ content: 'props off', revision: 3 });
  });

  it('points the screen where the assistant asks, and tells it when nobody is looking', async () => {
    const { claude, tab } = await world('ardupilot');
    expect((await claude.call('show', { target: 'ref.ap.motors' }))).toMatchObject({ shown: true, url: 'https://ardupilot.org/copter/docs/connect-escs-and-motors.html' });
    await until(() => tab.events.some(e => e.event === 'show' && e.data.target === 'ref.ap.motors' && e.data.by === 'Claude'));
    await tab.close();
    await until(async () => (await claude.call('show', { target: 'battery' })).shown === false);
    expect((await claude.call('get_workspace'))).toMatchObject({ lucidityOpen: false, aircraft: { connected: false } });
  });

  it('obeys the Off switch immediately', async () => {
    const { claude, browser, tab } = await world('ardupilot');
    void tab;
    await browser.request('PUT', '/api/mode', { mode: 'off' });
    expect((await claude.call('read', { ids: ['battery.voltage'] })).error.code).toBe('assistants_off');
    await browser.request('PUT', '/api/mode', { mode: 'propose' });
    expect((await claude.call('read', { ids: ['battery.voltage'] })).values[0].value).toBe(15.8);
  });
});

describe('two people', () => {
  it('cannot see or touch each other\'s documents, proposals, aircraft or assistants', async () => {
    const { app, browser: alice, claude, tab } = await world('ardupilot');
    void tab;
    await claude.call('read', { ids: ['settings.load'] });
    const doc = (await alice.post('/api/docs', { kind: 'file', name: 'alice notes', content: 'private' })).json;
    const proposal = await claude.call('propose_change', { changes: [{ id: 'param.RTL_ALT', value: 2000 }] });
    const bob = new Browser(app.base);
    await bob.signUp();
    expect((await bob.get(`/api/docs/${doc.id}`)).status).toBe(404);
    expect((await bob.request('PUT', `/api/docs/${doc.id}`, { baseRevision: 1, content: 'x' })).status).toBe(404);
    expect((await bob.post(`/api/proposals/${proposal.proposal}/decision`, { approve: true })).status).toBe(404);
    expect((await bob.get('/api/proposals')).json).toEqual([]);
    expect((await bob.get('/api/activity')).json).toEqual([]);
    expect((await bob.get('/api/export')).json.documents).toEqual([]);
    const bobsGrant = await bob.connectAssistant('Claude');
    const bobsClaude = await assistant(app.base, bobsGrant.access_token!);
    closers.push(() => bobsClaude.close());
    expect(await bobsClaude.call('get_workspace')).toMatchObject({ lucidityOpen: false, aircraft: { connected: false }, documents: [] });
    expect((await bobsClaude.call('read', { ids: [doc.id, 'battery.voltage'] })).values.every((v: any) => v.value === null)).toBe(true);
    expect((await bobsClaude.call('wait', { proposal: proposal.proposal, seconds: 1 })).error.code).toBe('not_found');
    expect((await alice.get(`/api/docs/${doc.id}`)).json.content).toBe('private');
  });
  it('deletes an account with everything it owned, and its assistants stop working', async () => {
    const { app, browser, claude } = await world();
    await browser.post('/api/docs', { kind: 'file', name: 'n', content: 'x' });
    expect((await browser.get('/api/export')).json.documents).toHaveLength(1);
    await browser.request('DELETE', '/api/account');
    await expect(claude.call('get_workspace')).rejects.toThrow();
    expect((await browser.get('/api/me')).json).toEqual({ signedIn: false });
    const left = (await Promise.all(['docs', 'activity', 'proposals', 'sessions', 'oauth_tokens', 'accounts'].map(c => app.store.list(c, '')))).flat();
    expect(left.filter(r => JSON.stringify(r).includes('acct_'))).toEqual([]);
  });
});

describe('on Postgres', () => {
  it('keeps accounts, sessions, documents and assistant tokens across a server restart', async () => {
    const pool = () => testPool('test_app_restart', false);
    const probe = await testPool('test_app_restart');
    if (!probe) return;
    await probe.end();
    const first = await startApp(await PgStore.open((await pool())!));
    const browser = new Browser(first.base);
    await browser.signUp();
    const doc = (await browser.post('/api/docs', { kind: 'file', name: 'kept', content: 'still here' })).json;
    const grant = await browser.connectAssistant('Claude');
    await first.close(); await first.store.close();

    const second = await startApp(await PgStore.open((await pool())!));
    closers.push(async () => { await second.close(); await second.store.close(); });
    const again = new Browser(second.base);
    again.cookie = browser.cookie;
    expect((await again.get(`/api/docs/${doc.id}`)).json).toMatchObject({ content: 'still here', revision: 1 });
    const claude = await assistant(second.base, grant.access_token!);
    closers.push(() => claude.close());
    expect((await claude.call('get_workspace')).documents).toMatchObject([{ id: doc.id, name: 'kept' }]);
    await again.request('DELETE', '/api/account');
  });
});

describe('building a drone', () => {
  it('lets the person and the assistant edit the same build through the same operations', async () => {
    const { browser, claude } = await world();
    const bad = await browser.post('/api/docs', { kind: 'build', name: 'Broken', content: { goal: {}, items: [{ slot: 'frame' }], log: [] } });
    expect(bad.json.error.code).toBe('invalid');
    const made = (await browser.post('/api/docs', { kind: 'build', name: 'Mine', content: { goal: {}, items: [], log: [] } })).json;
    expect(made.id).toMatch(/^build_/);
    const mine = await browser.post(`/api/docs/${made.id}/ops`, { baseRevision: 1, operations: [{ op: 'add', part: 'frame.apex-5' }] });
    expect(mine.json).toMatchObject({ revision: 2, content: { items: [{ slot: 'frame', part: 'frame.apex-5', by: 'you' }] } });
    const theirs = await claude.call('edit', { document: made.id, baseRevision: 2, operations: [{ op: 'add', part: 'motor.velox-v2207-1950' }] });
    expect(theirs.revision).toBe(3);
    const stale = await browser.post(`/api/docs/${made.id}/ops`, { baseRevision: 2, operations: [{ op: 'remove', slot: 'frame' }] });
    expect(stale.json.error.code).toBe('stale');
    const refused = await browser.post(`/api/docs/${made.id}/ops`, { baseRevision: 3, operations: [{ op: 'add', part: 'nope' }] });
    expect(refused.json.error).toMatchObject({ code: 'invalid', message: expect.stringMatching(/no part "nope"/) });
    const full = (await browser.get(`/api/docs/${made.id}`)).json;
    expect(full.content.items.map((i: any) => [i.slot, i.by])).toEqual([['frame', 'you'], ['motors', 'Claude']]);
    const file = (await browser.post('/api/docs', { kind: 'file', name: 'notes', content: 'x' })).json;
    expect((await browser.post(`/api/docs/${file.id}/ops`, { baseRevision: 1, operations: [] })).json.error.code).toBe('invalid');
  });
});

describe('rating parts', () => {
  it('keeps one rating per person per part, shares the average, and names nobody', async () => {
    const { app, browser } = await world();
    const other = new Browser(app.base);
    await other.signUp();
    expect((await browser.request('PUT', '/api/ratings/motor.velox-v2207-1950', { stars: 5, review: 'Tough.' })).json).toMatchObject({ average: 5, count: 1, mine: { stars: 5 } });
    expect((await browser.request('PUT', '/api/ratings/motor.velox-v2207-1950', { stars: 4, review: 'Tough, a bit hot.' })).json).toMatchObject({ average: 4, count: 1 });
    await other.request('PUT', '/api/ratings/motor.velox-v2207-1950', { stars: 2 });
    const all = (await other.get('/api/ratings')).json;
    expect(all['motor.velox-v2207-1950']).toMatchObject({ average: 3, count: 2, histogram: [0, 1, 0, 1, 0], mine: { stars: 2 } });
    const detail = (await other.get('/api/ratings/motor.velox-v2207-1950')).json;
    expect(detail.reviews).toEqual([expect.objectContaining({ stars: 2, mine: true }), expect.objectContaining({ stars: 4, review: 'Tough, a bit hot.', mine: false })]);
    expect(JSON.stringify(detail)).not.toMatch(/@example|acct_|account/);
    expect((await browser.request('PUT', '/api/ratings/motor.velox-v2207-1950', { stars: 6 })).json.error.code).toBe('invalid');
    expect((await browser.request('PUT', '/api/ratings/not-a-part', { stars: 3 })).status).toBe(404);
    await other.request('DELETE', '/api/ratings/motor.velox-v2207-1950');
    expect((await browser.get('/api/ratings')).json['motor.velox-v2207-1950']).toMatchObject({ average: 4, count: 1 });
    expect((await new Browser(app.base).get('/api/ratings')).status).toBe(401);
  });
});
