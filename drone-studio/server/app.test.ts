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
    expect((await b.get('/api/me')).json).toMatchObject({ signedIn: false });
    const email = await b.signUp();
    expect((await b.get('/api/me')).json).toMatchObject({ signedIn: true, email, mode: 'observe', mcpUrl: `${app.base}/mcp`, assistants: [] });
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
    expect((await b.get('/api/me')).json.mode).toBe('observe');
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
    expect(grant.details).toEqual({ client: 'Claude', clientId: grant.clientId, scopes: ['observe', 'design', 'propose'], redirectHost: 'localhost:9' });
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
    expect((await claude.call('get_workspace')).armableOpen).toBe(false);
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
    expect(claude.client.getInstructions()).toContain('"Start Armable", or a first message: call get_workspace');
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
    const bearer = { Authorization: `Bearer ${grant.access_token}`, 'x-armable': '1', 'content-type': 'application/json' };
    for (const [path, body] of [[`/api/proposals/${p.proposal}/decision`, { approve: true }], [`/api/proposals/${p.proposal}/result`, { ok: true, summary: 'done' }], ['/api/mode', { mode: 'propose' }]] as const)
      expect((await fetch(app.base + path, { method: path === '/api/mode' ? 'PUT' : 'POST', headers: bearer, body: JSON.stringify(body) })).status).toBe(401);
    // The token is not a session cookie either.
    expect((await fetch(`${app.base}/api/proposals/${p.proposal}/decision`, { method: 'POST', headers: { cookie: `armable_session=${grant.access_token}`, 'x-armable': '1', 'content-type': 'application/json' }, body: '{"approve":true}' })).status).toBe(401);
    const { WebSocket } = await import('ws');
    const refused = await new Promise<string>(resolve => { const ws = new WebSocket(app.base.replace('http', 'ws') + '/live', { headers: { Authorization: `Bearer ${grant.access_token}`, cookie: `armable_session=${grant.access_token}` } }); ws.once('open', () => resolve('open')); ws.once('error', () => resolve('refused')); });
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
    expect((await claude.call('get_workspace'))).toMatchObject({ armableOpen: false, aircraft: { connected: false } });
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
    expect(await bobsClaude.call('get_workspace')).toMatchObject({ armableOpen: false, aircraft: { connected: false }, documents: [] });
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
    expect((await browser.get('/api/me')).json).toMatchObject({ signedIn: false });
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
    expect((await new Browser(app.base).get('/api/ratings')).json['motor.velox-v2207-1950']).toMatchObject({ average: 4, count: 1 });
    expect((await new Browser(app.base).request('PUT', '/api/ratings/motor.velox-v2207-1950', { stars: 5 })).status).toBe(401);
  });
});

describe('trying it without signing up', () => {
  it('makes a guest bench that works fully, then saves it with an email and keeps everything', async () => {
    const app = await startApp(); closers.push(() => app.close());
    const b = new Browser(app.base);
    expect((await b.get('/api/me')).json).toEqual({ signedIn: false, google: false });
    expect((await b.post('/api/guest')).json).toEqual({ signedIn: true, guest: true });
    expect((await b.get('/api/me')).json).toMatchObject({ signedIn: true, guest: true, email: '' });
    const doc = (await b.post('/api/docs', { kind: 'file', name: 'notes', content: 'props off' })).json;
    // An assistant can connect to a guest bench too.
    const grant = await b.connectAssistant('Claude');
    expect(grant.access_token).toBeTruthy();
    expect((await b.post('/api/save', { email: 'Pilot@Example.test', password: 'short' })).json.error.code).toBe('invalid');
    expect((await b.post('/api/save', { email: 'Pilot@Example.test', password: 'correct horse' })).json).toEqual({ email: 'pilot@example.test' });
    expect((await b.get('/api/me')).json).toMatchObject({ signedIn: true, guest: false, email: 'pilot@example.test' });
    expect((await b.post('/api/save', { email: 'x@example.test', password: 'correct horse' })).json.error.code).toBe('invalid');
    const again = new Browser(app.base);
    await again.post('/api/login', { email: 'pilot@example.test', password: 'correct horse' });
    expect((await again.get(`/api/docs/${doc.id}`)).json).toMatchObject({ content: 'props off' });
  });

  it('deletes guest benches nobody has opened for 30 days, and keeps saved ones', async () => {
    const app = await startApp(); closers.push(() => app.close());
    const old = new Browser(app.base), kept = new Browser(app.base);
    await old.post('/api/guest'); await kept.post('/api/guest');
    await kept.post('/api/save', { email: 'kept@example.test', password: 'correct horse' });
    const accounts = await app.store.list<{ guest?: boolean; lastSeen?: number }>('accounts', '', 100);
    for (const row of accounts) await app.store.put('accounts', '', row.id, { ...row.data, lastSeen: Date.now() - 31 * 86400_000, createdAt: Date.now() - 31 * 86400_000 });
    expect(await app.auth.purgeGuests(30)).toHaveLength(1);
    expect((await old.get('/api/me')).json.signedIn).toBe(false);
    expect((await kept.get('/api/me')).json).toMatchObject({ signedIn: true, email: 'kept@example.test' });
  });

  it('signs in with Google, saving the guest bench under the verified email', async () => {
    const claims = { iss: 'https://accounts.google.com', aud: 'client-1', sub: 'google-42', email: 'flyer@example.test', email_verified: true, exp: Math.floor(Date.now() / 1000) + 600 };
    const idToken = `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
    const fakeFetch = (async () => new Response(JSON.stringify({ id_token: idToken }), { status: 200 })) as typeof fetch;
    const app = await startApp(undefined, undefined, undefined, { google: { clientId: 'client-1', clientSecret: 'secret', fetch: fakeFetch } }); closers.push(() => app.close());
    const b = new Browser(app.base);
    await b.post('/api/guest');
    const doc = (await b.post('/api/docs', { kind: 'file', name: 'mine', content: 'x' })).json;
    expect((await b.get('/api/me')).json.google).toBe(true);
    const start = await fetch(`${app.base}/auth/google?next=/build`, { redirect: 'manual', headers: { cookie: b.cookie } });
    expect(start.headers.get('location')).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?client_id=client-1/);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const stateCookie = start.headers.get('set-cookie')!.split(';')[0];
    const forged = await fetch(`${app.base}/auth/google/callback?code=abc&state=wrong`, { redirect: 'manual', headers: { cookie: `${b.cookie}; ${stateCookie}` } });
    expect(forged.headers.get('location')).toMatch(/^\/\?signin=/);
    const back = await fetch(`${app.base}/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`, { redirect: 'manual', headers: { cookie: `${b.cookie}; ${stateCookie}` } });
    expect(back.headers.get('location')).toBe('/build');
    b.cookie = back.headers.get('set-cookie')!.split(';')[0];
    expect((await b.get('/api/me')).json).toMatchObject({ signedIn: true, guest: false, email: 'flyer@example.test' });
    expect((await b.get(`/api/docs/${doc.id}`)).json.content).toBe('x');
    expect((await b.post('/api/login', { email: 'flyer@example.test', password: 'anything long' })).json.error.code).toBe('invalid');
  });
});

describe('feedback and shared builds', () => {
  it('takes feedback with context and a screenshot, and only admins can read it all', async () => {
    const app = await startApp(undefined, undefined, undefined, { admins: ['boss@example.test'] }); closers.push(() => app.close());
    const b = new Browser(app.base);
    await b.post('/api/guest');
    expect((await b.post('/api/feedback', { text: '' })).json.error.code).toBe('invalid');
    expect((await b.post('/api/feedback', { text: 'Loved the dials.', context: { view: 'build', browser: 'Chrome' }, screenshot: 'data:image/png;base64,iVBORw0KGgo=' })).json).toEqual({ thanks: true });
    expect((await b.post('/api/feedback', { kind: 'helpful', helpful: true })).json).toEqual({ thanks: true });
    expect((await b.get('/api/admin/feedback')).status).toBe(404);
    // Signing up with the admin email is not enough: sign-up never proves the address.
    const impostor = new Browser(app.base);
    await impostor.signUp('boss@example.test');
    expect((await impostor.get('/api/admin/feedback')).status).toBe(404);
    // Proving it with Google is.
    const boss = new Browser(app.base);
    boss.cookie = `armable_session=${await app.auth.startSession((await app.auth.google({ sub: 'g-boss', email: 'boss@example.test' })).id)}`;
    const all = (await boss.get('/api/admin/feedback')).json;
    expect(all.map((f: any) => f.kind).sort()).toEqual(['feedback', 'helpful']);
    const note = all.find((f: any) => f.kind === 'feedback');
    expect(note).toMatchObject({ text: 'Loved the dials.', guest: true, context: { view: 'build' } });
    const image = await fetch(app.base + note.screenshot, { headers: { cookie: boss.cookie } });
    expect(image.headers.get('content-type')).toMatch(/image\/png/);
  });

  it('shares a build by link for anyone to read, and lets others copy it', async () => {
    const app = await startApp(); closers.push(() => app.close());
    const owner = new Browser(app.base);
    await owner.post('/api/guest');
    const build = (await owner.post('/api/docs', { kind: 'build', name: 'Shared quad', content: { goal: {}, items: [], log: [] } })).json;
    const shared = (await owner.post(`/api/docs/${build.id}/share`)).json;
    expect(shared.url).toBe(`${app.base}/b/${shared.share}`);
    expect((await owner.post(`/api/docs/${build.id}/share`)).json.share).toBe(shared.share);
    const stranger = new Browser(app.base);
    expect((await stranger.get(`/api/shared/${shared.share}`)).json).toMatchObject({ name: 'Shared quad', content: { items: [] } });
    expect((await stranger.post(`/api/shared/${shared.share}/copy`)).status).toBe(401);
    await stranger.post('/api/guest');
    const copy = (await stranger.post(`/api/shared/${shared.share}/copy`)).json;
    expect((await stranger.get(`/api/docs/${copy.id}`)).json).toMatchObject({ kind: 'build', name: 'Shared quad' });
    await owner.request('DELETE', `/api/docs/${build.id}/share`);
    expect((await stranger.get(`/api/shared/${shared.share}`)).status).toBe(404);
    const file = (await owner.post('/api/docs', { kind: 'file', name: 'f', content: 'x' })).json;
    expect((await owner.post(`/api/docs/${file.id}/share`)).json.error.code).toBe('invalid');
  });
});


describe('the Allow screen', () => {
  it('tells anyone the name an assistant registered with, and nothing about unknown ones', async () => {
    const app = await startApp(); closers.push(() => app.close());
    const person = new Browser(app.base);
    await person.signUp();
    const grant = await person.connectAssistant('Claude');
    expect((await new Browser(app.base).get(`/api/oauth-client/${grant.clientId}`)).json).toEqual({ name: 'Claude' });
    expect((await new Browser(app.base).get('/api/oauth-client/nope')).status).toBe(404);
  });
});

describe('security', () => {
  it('turns away large anonymous requests before reading them, but not signed-in ones', async () => {
    const app = await startApp(); closers.push(() => app.close());
    const big = 'x'.repeat(200_000);
    const anonymous = new Browser(app.base);
    expect((await anonymous.post('/api/login', { email: big, password: 'correct horse' })).status).toBe(413);
    const person = new Browser(app.base);
    await person.post('/api/guest');
    expect((await person.post('/api/docs', { kind: 'file', name: 'big notes', content: 'y'.repeat(150_000) })).status).toBe(200);
  });

  it('never sends a browser to another site after Google sign-in', async () => {
    const claims = { iss: 'https://accounts.google.com', aud: 'c', sub: 'g-1', email: 'safe@example.test', email_verified: true, exp: Math.floor(Date.now() / 1000) + 600 };
    const fakeFetch = (async () => new Response(JSON.stringify({ id_token: `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y` }))) as typeof fetch;
    const app = await startApp(undefined, undefined, undefined, { google: { clientId: 'c', clientSecret: 's', fetch: fakeFetch } }); closers.push(() => app.close());
    for (const next of ['//evil.example', '/\\evil.example', 'https://evil.example']) {
      const start = await fetch(`${app.base}/auth/google?next=${encodeURIComponent(next)}`, { redirect: 'manual' });
      const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
      const back = await fetch(`${app.base}/auth/google/callback?code=a&state=${encodeURIComponent(state)}`, { redirect: 'manual', headers: { cookie: start.headers.get('set-cookie')!.split(';')[0] } });
      expect(back.headers.get('location'), next).toBe('/');
    }
  });

  it('when Google proves an email, whoever registered it first loses their password, sessions and assistants', async () => {
    const app = await startApp(); closers.push(() => app.close());
    const attacker = new Browser(app.base);
    await attacker.signUp('victim@example.test', 'attacker password');
    const grant = await attacker.connectAssistant('Claude');
    expect((await app.auth.verify(grant.access_token!)).extra?.account).toBeTruthy();
    const account = await app.auth.google({ sub: 'g-victim', email: 'victim@example.test' });
    expect(account.passwordHash).toBe('');
    expect((await attacker.get('/api/me')).json.signedIn).toBe(false);
    expect((await new Browser(app.base).post('/api/login', { email: 'victim@example.test', password: 'attacker password' })).json.error.code).toBe('invalid');
    await expect(app.auth.verify(grant.access_token!)).rejects.toThrow();
    // Signing in with Google again changes nothing.
    expect((await app.auth.google({ sub: 'g-victim', email: 'victim@example.test' })).id).toBe(account.id);
  });

  it('lets an assistant app revoke only its own tokens', async () => {
    const app = await startApp(); closers.push(() => app.close());
    const person = new Browser(app.base);
    await person.signUp();
    const grant = await person.connectAssistant('Claude');
    await app.auth.revoke(grant.access_token!, 'some-other-client');
    expect((await app.auth.verify(grant.access_token!)).clientId).toBe(grant.clientId);
    await app.auth.revoke(grant.access_token!, grant.clientId);
    await expect(app.auth.verify(grant.access_token!)).rejects.toThrow();
  });
});
