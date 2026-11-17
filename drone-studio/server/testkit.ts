import { Bench, type ProposalOutcome } from '../src/bench/bench';
import { Runtime, type RuntimeOptions } from '../src/device/runtime';
import type { ArdupilotSim } from '../src/device/sim/ardupilot';
import type { BetaflightSim } from '../src/device/sim/betaflight';
import { ardupilotDemo, betaflightDemo } from '../src/device/sim/demo';
import type { Condition } from '../src/device/types';
import { Services, ToolError, type Account } from './services';
import { MemoryStore, type Store } from './store';
import { TOOLS, type ToolContext } from './tools';

/** Tests reach into whichever simulator is running. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SimHandle = any;
export type { ArdupilotSim, BetaflightSim };
/** Fast timings for tests. */
export const FAST: RuntimeOptions = {
  detectMs: 600, reconnectMs: 3000,
  mav: { heartbeatMs: 800, ackMs: 250, paramIdleMs: 60, echoMs: 150, quietMs: 30, restoreMs: 400, logIdleMs: 60, esc: { responseMs: 300, settleMs: 1, retryMs: 1 } },
  bf: { mspMs: 300, cliMs: 2000, cliIdleMs: 15, pollMs: 15, rebootMs: 60, esc: { responseMs: 300, settleMs: 1, retryMs: 1 } },
};
export async function makeAccount(services: Services, email = 'pilot@example.test'): Promise<Account> {
  const account: Account = { id: `acct_${Math.random().toString(36).slice(2, 10)}`, email, passwordHash: 'x', createdAt: Date.now(), assistantMode: 'propose' };
  await services.store.put('accounts', '', account.id, account, { lookup: email });
  return account;
}
/** Call a tool the way the MCP layer does, returning the result or the ToolError. */
export async function callTool(services: Services, account: string, name: string, args: Record<string, unknown> = {}, who = 'Claude'): Promise<any> {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  const ctx: ToolContext = { account, who, services, now: Date.now };
  try { return await tool.run(args, ctx); }
  catch (error) { if (error instanceof ToolError) return { error: { code: error.code, message: error.message, hint: error.hint, ...error.extra } }; throw error; }
}

/** A whole bench in one process: a simulated aircraft, the runtime, and the tab link wired straight into a hub. */
export async function openBench(services: Services, account: string, stack: 'ardupilot' | 'betaflight' = 'ardupilot', simOptions: Record<string, unknown> = {}) {
  const source = stack === 'ardupilot' ? ardupilotDemo({ tickMs: 10, ...simOptions }) : betaflightDemo(simOptions);
  const runtime = new Runtime(FAST);
  const hub = services.hub(account);
  const tabId = `tab_${Math.random().toString(36).slice(2, 8)}`;
  const bench = new Bench(runtime, { mirror: m => { hub.mirror = m; }, reply: (id, ok, payload) => hub.settle(id, ok, payload) }, { stateEveryMs: 20 });
  hub.attach({ id: tabId, bench: true, active: Date.now(), send: message => { if (message.type === 'rpc') void bench.handle(message.id, message.request); } });
  await runtime.connect(source);
  bench.flush();
  return {
    runtime, bench, sim: source.sim as SimHandle, tabId,
    /** What the person does: approve in the signed-in tab, confirm conditions, and let the tab carry it out. */
    async approve(proposalId: string, conditions: Condition[] = [], prompt?: Parameters<Bench['execute']>[2]): Promise<ProposalOutcome> {
      const proposal = await services.decide(account, proposalId, true);
      const outcome = await bench.execute(proposal, conditions, prompt);
      await services.complete(account, proposalId, outcome);
      return outcome;
    },
    async close() { bench.dispose(); hub.detach(tabId); await runtime.disconnect(); (source.sim as { stop?: () => void }).stop?.(); },
  };
}
export function makeServices(store: Store = new MemoryStore()) { return new Services(store); }

// ---- Over real HTTP ------------------------------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from './app';

const freePort = () => new Promise<number>(resolve => { const s = createServer(); s.listen(0, () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); }); });
export async function startApp(store: Store = new MemoryStore()) {
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const app = createApp({ store, publicUrl: base, quiet: true, limits: false });
  await new Promise<void>(resolve => app.http.listen(port, '127.0.0.1', resolve));
  return { ...app, base, port, store };
}
/** A person's browser: it keeps the session cookie and sends the header the API requires. */
export class Browser {
  cookie = '';
  constructor(readonly base: string) {}
  async request(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
    const response = await fetch(this.base + path, { method, redirect: 'manual', headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...(method === 'GET' ? {} : { 'x-lucidity': '1', 'content-type': 'application/json' }), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = response.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    const text = await response.text();
    let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: response.status, json, location: response.headers.get('location') };
  }
  get(path: string) { return this.request('GET', path); }
  post(path: string, body: unknown = {}) { return this.request('POST', path, body); }
  async signUp(email = `pilot${Math.random().toString(36).slice(2, 8)}@example.test`, password = 'correct horse') { const r = await this.post('/api/signup', { email, password }); if (r.status !== 200) throw new Error(`signup failed: ${JSON.stringify(r.json)}`); return email; }

  /** Connect an assistant the way a real one does: register, send the person to approve, exchange the code. */
  async connectAssistant(name = 'Claude', scope = 'observe design propose', allow = true) {
    const redirect = 'http://localhost:9/callback';
    const registered = await (await fetch(`${this.base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) })).json() as { client_id: string };
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const query = new URLSearchParams({ response_type: 'code', client_id: registered.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', scope });
    const started = await this.get(`/authorize?${query}`);
    const consent = new URL(started.location ?? '', this.base).searchParams.get('consent');
    if (!consent) return { clientId: registered.client_id, started };
    const details = (await this.get(`/api/oauth/${consent}`)).json;
    const decided = (await this.post(`/api/oauth/${consent}`, { allow })).json as { redirect: string };
    const code = new URL(decided.redirect).searchParams.get('code');
    if (!code) return { clientId: registered.client_id, details, denied: new URL(decided.redirect).searchParams.get('error') };
    const tokens = await (await fetch(`${this.base}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: registered.client_id, redirect_uri: redirect }) })).json() as { access_token: string; refresh_token: string };
    return { clientId: registered.client_id, details, code, verifier, redirect, ...tokens };
  }
}
/** An assistant: an MCP client holding a bearer token. */
export async function assistant(base: string, token: string, name = 'Claude') {
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return {
    client,
    async call(tool: string, args: Record<string, unknown> = {}): Promise<any> {
      const result = await client.callTool({ name: tool, arguments: args }) as { content: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean };
      return result.structuredContent ?? JSON.parse(result.content[0].text ?? 'null');
    },
    close: () => client.close(),
  };
}
/** A Lucidity browser tab with a simulated drone plugged in, talking to the server over a real WebSocket. */
export async function openTab(browser: Browser, stack: 'ardupilot' | 'betaflight' = 'ardupilot', simOptions: Record<string, unknown> = {}) {
  const ws = new WebSocket(browser.base.replace('http', 'ws') + '/live', { headers: { cookie: browser.cookie, origin: browser.base } });
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
  const events: { event: string; data: any }[] = [];
  const source = stack === 'ardupilot' ? ardupilotDemo({ tickMs: 10, ...simOptions }) : betaflightDemo(simOptions);
  const runtime = new Runtime(FAST);
  const send = (message: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message)); };
  const bench = new Bench(runtime, { mirror: mirror => send({ type: 'mirror', mirror }), reply: (id, ok, payload) => send({ type: 'reply', id, ok, payload }) }, { stateEveryMs: 30 });
  ws.on('message', raw => { const m = JSON.parse(String(raw)); if (m.type === 'rpc') void bench.handle(m.id, m.request); else if (m.type === 'event') events.push(m); });
  send({ type: 'hello', tab: `tab_${Math.random().toString(36).slice(2, 8)}` });
  await runtime.connect(source);
  bench.flush();
  await new Promise(r => setTimeout(r, 60));
  return {
    ws, runtime, bench, events, sim: source.sim as SimHandle, send,
    /** The person clicks Approve: the decision goes to the server with their cookie, this tab does the work, and reports back. */
    async approve(proposalId: string, conditions: Condition[] = []) {
      const decided = await browser.post(`/api/proposals/${proposalId}/decision`, { approve: true });
      if (decided.status !== 200) throw new Error(`decision refused: ${JSON.stringify(decided.json)}`);
      const outcome = await bench.execute(decided.json, conditions);
      await browser.post(`/api/proposals/${proposalId}/result`, outcome);
      return outcome;
    },
    async close() { bench.dispose(); ws.close(); await runtime.disconnect(); (source.sim as { stop?: () => void }).stop?.(); },
  };
}
