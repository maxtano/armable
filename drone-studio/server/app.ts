import { agentSkill, onboardingUrls } from './onboarding';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { WebSocketServer, type WebSocket } from 'ws';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { projectSchema } from '../src/core/model';
import { applyBuildOps, BUILD_OPS_HINT, BuildError, buildSchema, type Build } from '../src/build/build';
import { PART_BY_ID } from '../src/build/catalog';
import type { Mirror } from '../src/map/map';
import type { Condition } from '../src/device/types';
import { Auth, OAuthProvider, SCOPES } from './auth';
import { buildMcp } from './mcp';
import { Services, ToolError, type AssistantMode, type DocKind, type Focus } from './services';
import type { Store } from './store';
import { MemoryTracker, TRACK_TABLES, type Tracker, type TrackTable } from './tracker';

/**
 * The cloud service: sign-in, documents, proposals, the live channel to browser tabs, and the MCP endpoint.
 * Two kinds of caller reach it. A person's browser carries a session cookie and can approve. An assistant
 * carries a bearer token and can only use the tools. The approve route accepts the cookie and nothing else.
 */
export interface AppOptions {
  store: Store; publicUrl: string; staticDir?: string; quiet?: boolean; limits?: boolean; trustProxy?: number; tracker?: Tracker;
  /** Sign in with Google, when a client is configured. `fetch` is replaceable for tests. */
  google?: { clientId: string; clientSecret: string; fetch?: typeof fetch };
  /** Where feedback is also posted, e.g. a Discord webhook. */
  feedbackWebhook?: string;
  /** Emails that may read all feedback at /api/admin/feedback. */
  admins?: string[];
}
const COOKIE = 'armable_session';
const cookie = {
  parse(header: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of header.split(';')) { const at = part.indexOf('='); if (at > 0) { try { out[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim()); } catch { /* ignore a malformed value */ } } }
    return out;
  },
  serialize(name: string, value: string, o: { httpOnly?: boolean; secure?: boolean; sameSite?: 'lax'; path?: string; maxAge?: number }): string {
    return [`${name}=${encodeURIComponent(value)}`, o.path && `Path=${o.path}`, o.maxAge !== undefined && `Max-Age=${o.maxAge}`, o.httpOnly && 'HttpOnly', o.secure && 'Secure', o.sameSite && 'SameSite=Lax'].filter(Boolean).join('; ');
  },
};
type Authed = Request & { account: string };

export function createApp(options: AppOptions) {
  const { store } = options;
  const publicUrl = new URL(options.publicUrl);
  const secure = publicUrl.protocol === 'https:';
  const tracker = options.tracker ?? new MemoryTracker();
  const services = new Services(store, Date.now, tracker);
  const auth = new Auth(store);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', options.trustProxy ?? 1);

  const sessionToken = (req: IncomingMessage) => cookie.parse(req.headers.cookie ?? '')[COOKIE];
  const provider = new OAuthProvider(auth, store, res => auth.session(sessionToken(res.req)), publicUrl.href);

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; frame-src https://www.youtube-nocookie.com; worker-src 'self' blob:; base-uri 'none'; form-action 'self'");
    next();
  });

  // ---- Assistants: OAuth endpoints and the MCP endpoint ------------------------------------------------------------

  const mcpUrl = new URL('/mcp', publicUrl);
  app.use(mcpAuthRouter({ provider, issuerUrl: publicUrl, scopesSupported: [...SCOPES], resourceName: 'Armable', resourceServerUrl: mcpUrl,
    ...(options.limits === false ? { authorizationOptions: { rateLimit: false }, tokenOptions: { rateLimit: false }, clientRegistrationOptions: { rateLimit: false }, revocationOptions: { rateLimit: false } } : {}) }));
  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: new URL('/.well-known/oauth-protected-resource/mcp', publicUrl).href });
  app.post('/mcp', bearer, express.json({ limit: '1mb' }), async (req, res) => {
    const info = (req as Request & { auth?: { scopes: string[]; clientId?: string; extra?: { account?: string; clientName?: string } } }).auth;
    const account = info?.extra?.account;
    if (!account) { res.status(401).json({ error: 'invalid_token' }); return; }
    const server = buildMcp(services, { account, who: info!.extra!.clientName ?? 'Assistant', scopes: info!.scopes, clientId: info!.clientId });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { void transport.close(); void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch (error) { if (!options.quiet) console.error('[mcp] request failed', error); if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }); }
  });
  const noSession = (_req: Request, res: Response) => { res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'This server keeps no sessions. Use POST.' }, id: null }); };
  app.get('/mcp', noSession);
  app.delete('/mcp', noSession);

  // ---- People: the browser API -----------------------------------------------------------------------------------

  const api = express.Router();
  api.use(express.json({ limit: '34mb' }));
  // A custom header cannot be sent by another site's form or script without our permission, so it stands in for a CSRF token.
  api.use((req, res, next) => { if (req.method !== 'GET' && req.get('x-armable') !== '1') { res.status(403).json({ error: { code: 'forbidden', message: 'Missing request header.' } }); return; } next(); });
  const limiter = options.limits === false ? (_q: Request, _s: Response, n: NextFunction) => n() : rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });
  const setSession = (res: Response, token: string) => res.setHeader('Set-Cookie', cookie.serialize(COOKIE, token, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: 30 * 86400 }));
  const person = async (req: Request, res: Response, next: NextFunction) => {
    const account = await auth.session(sessionToken(req));
    if (!account) { res.status(401).json({ error: { code: 'signed_out', message: 'Sign in first.' } }); return; }
    (req as Authed).account = account;
    next();
  };
  const wrap = (fn: (req: Authed, res: Response) => Promise<unknown>) => (req: Request, res: Response) => {
    fn(req as Authed, res).then(result => { if (!res.headersSent) res.json(result ?? { ok: true }); }).catch(error => {
      if (error instanceof ToolError) res.status(error.code === 'not_found' ? 404 : error.code === 'stale' ? 409 : 400).json({ error: { code: error.code, message: error.message, hint: error.hint, ...error.extra } });
      else { if (!options.quiet) console.error('[api]', error); res.status(500).json({ error: { code: 'internal', message: 'Something went wrong.' } }); }
    });
  };
  const text = (value: unknown, max = 200) => { if (typeof value !== 'string' || value.length > max) throw new ToolError('invalid', 'Invalid request.'); return value; };

  api.post('/signup', limiter, wrap(async (req, res) => { const account = await auth.signUp(text(req.body.email), text(req.body.password)); setSession(res, await auth.startSession(account.id)); return { email: account.email }; }));
  api.post('/login', limiter, wrap(async (req, res) => { const account = await auth.signIn(text(req.body.email), text(req.body.password)); setSession(res, await auth.startSession(account.id)); return { email: account.email }; }));
  api.post('/logout', wrap(async (req, res) => { await auth.endSession(sessionToken(req)); res.setHeader('Set-Cookie', cookie.serialize(COOKIE, '', { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: 0 })); }));
  // Public: where assistants connect, for the “Connect your AI” menu on the intro page.
  api.get('/connect', wrap(async () => { const { mcpUrl, skillUrl } = onboardingUrls(publicUrl); return { mcpUrl, skillUrl }; }));
  // Try it without signing up: a guest bench that works fully, and can be saved later.
  api.post('/guest', limiter, wrap(async (req, res) => {
    const current = await auth.session(sessionToken(req));
    if (current) return { signedIn: true };
    const account = await auth.guest();
    setSession(res, await auth.startSession(account.id));
    return { signedIn: true, guest: true };
  }));
  api.get('/me', wrap(async req => {
    const id = await auth.session(sessionToken(req));
    const account = id ? await services.account(id) : undefined;
    if (!account) return { signedIn: false, google: !!options.google };
    void auth.seen(account);
    const hub = services.hub(account.id);
    return { signedIn: true, guest: account.guest ?? false, google: !!options.google, email: account.email, mode: account.assistantMode, mcpUrl: mcpUrl.href, assistants: (await auth.grants(account.id)).map(g => ({ ...g, lastSeen: hub.assistants.get(g.name) ?? null })) };
  }));

  const ratedPart = (id: string) => { if (!PART_BY_ID.has(id)) throw new ToolError('not_found', 'Only parts in the catalog can be rated.'); return id; };
  const viewer = async (req: Request) => await auth.session(sessionToken(req));
  api.get('/ratings', wrap(async req => services.ratings(await viewer(req))));
  api.get('/ratings/:part', wrap(async req => services.reviews(ratedPart(String(req.params.part)), await viewer(req))));

  // A shared build: read-only, for anyone with the link.
  api.get('/shared/:share', wrap(async req => {
    const share = await store.get<{ account: string; doc: string }>('shares', '_public', String(req.params.share));
    const doc = share && await store.get<{ kind: string; name: string; content: unknown }>('docs', share.data.account, share.data.doc);
    if (!doc || doc.data.kind !== 'build') throw new ToolError('not_found', 'This build is no longer shared.');
    return { name: doc.data.name, content: doc.data.content, updatedAt: doc.updatedAt };
  }));

  api.use(person);
  // Save a guest bench with an email and password. Everything on it stays.
  api.post('/save', limiter, wrap(async req => { const account = await auth.save(req.account, text(req.body.email), text(req.body.password)); return { email: account.email }; }));

  // Feedback: a few words, optionally a screenshot, and what the person was looking at.
  api.post('/feedback', limiter, wrap(async req => {
    const b = req.body ?? {};
    const kind = b.kind === 'helpful' ? 'helpful' : 'feedback';
    const message = typeof b.text === 'string' ? b.text.trim().slice(0, 4000) : '';
    const helpful = typeof b.helpful === 'boolean' ? b.helpful : undefined;
    if (!message && helpful === undefined) throw new ToolError('invalid', 'Write a few words first.');
    const screenshot = typeof b.screenshot === 'string' && b.screenshot.startsWith('data:image/') && b.screenshot.length < 4_000_000 ? b.screenshot : undefined;
    const context = b.context && typeof b.context === 'object' ? JSON.parse(JSON.stringify(b.context).slice(0, 4000).replace(/[^}]*$/, '') || '{}') as Record<string, unknown> : {};
    const account = await services.account(req.account);
    const row = await store.append('feedback', '_feedback', { at: Date.now(), account: req.account, email: account?.email || undefined, guest: account?.guest ?? false, kind, text: message, helpful, context, screenshot });
    if (options.feedbackWebhook) {
      const line = kind === 'helpful' ? `${helpful ? '👍' : '👎'} Did this help? ${message}` : `💬 ${message}`;
      const where = [context.view, context.firmware, context.browser].filter(Boolean).join(' · ');
      void fetch(options.feedbackWebhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: `${line}\n${where ? `_${where}_ · ` : ''}${account?.email || 'guest'}${screenshot ? ' · screenshot saved' : ''} · \`${row.id}\``.slice(0, 1900) }), signal: AbortSignal.timeout(5000) }).catch(() => {});
    }
    return { thanks: true };
  }));
  api.get('/admin/feedback', wrap(async req => {
    const account = await services.account(req.account);
    if (!account?.email || !(options.admins ?? []).includes(account.email)) throw new ToolError('not_found', 'No such route.');
    return (await store.list<Record<string, unknown>>('feedback', '_feedback', 500)).map(r => ({ id: r.id, ...r.data, screenshot: r.data.screenshot ? `/api/admin/feedback/${r.id}/screenshot` : undefined }));
  }));
  api.get('/admin/feedback/:id/screenshot', async (req, res) => {
    const account = await services.account((req as unknown as Authed).account);
    if (!account?.email || !(options.admins ?? []).includes(account.email)) { res.status(404).end(); return; }
    const row = await store.get<{ screenshot?: string }>('feedback', '_feedback', String(req.params.id));
    const match = row?.data.screenshot?.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
    if (!match) { res.status(404).end(); return; }
    res.type(match[1]).send(Buffer.from(match[2], 'base64'));
  });

  // Share a build: one stable link per build, until it is unshared.
  api.post('/docs/:id/share', wrap(async req => {
    const doc = await services.doc(req.account, String(req.params.id));
    if (doc.data.kind !== 'build') throw new ToolError('invalid', 'Only builds can be shared.');
    const key = `share:${req.account}:${doc.id}`, existing = await store.lookup<{ account: string; doc: string }>('shares', key);
    if (existing) return { share: existing.id, url: new URL(`/b/${existing.id}`, publicUrl).href };
    const id = randomBytes(6).toString('base64url');
    await store.put('shares', '_public', id, { account: req.account, doc: doc.id }, { expectedRev: 0, lookup: key });
    return { share: id, url: new URL(`/b/${id}`, publicUrl).href };
  }));
  api.delete('/docs/:id/share', wrap(async req => {
    const existing = await store.lookup('shares', `share:${req.account}:${String(req.params.id)}`);
    if (existing) await store.delete('shares', '_public', existing.id);
  }));
  api.get('/docs/:id/share', wrap(async req => {
    const existing = await store.lookup('shares', `share:${req.account}:${String(req.params.id)}`);
    return existing ? { share: existing.id, url: new URL(`/b/${existing.id}`, publicUrl).href } : { share: null };
  }));
  // Copy someone's shared build into your own bench.
  api.post('/shared/:share/copy', wrap(async req => {
    const share = await store.get<{ account: string; doc: string }>('shares', '_public', String(req.params.share));
    const doc = share && await store.get<{ kind: string; name: string; content: unknown }>('docs', share.data.account, share.data.doc);
    if (!doc || doc.data.kind !== 'build') throw new ToolError('not_found', 'This build is no longer shared.');
    const row = await services.createDoc(req.account, 'build', doc.data.name, content('build', doc.data.content), 'you');
    return { id: row.id, revision: row.rev };
  }));

  api.put('/mode', wrap(async req => { const mode = req.body.mode as AssistantMode; if (!['off', 'observe', 'propose'].includes(mode)) throw new ToolError('invalid', 'Unknown mode.'); await services.setMode(req.account, mode); }));
  api.delete('/assistants/:client', wrap(async req => { await auth.disconnect(req.account, String(req.params.client)); services.hub(req.account).notify('assistants'); }));
  api.delete('/account', wrap(async (req, res) => { await services.forgetRatings(req.account); await tracker.deleteAccount(req.account); await auth.deleteAccount(req.account); res.setHeader('Set-Cookie', cookie.serialize(COOKIE, '', { path: '/', maxAge: 0 })); }));
  api.get('/export', wrap(async req => ({ exportedAt: new Date().toISOString(), documents: (await services.docs(req.account)).map(r => ({ id: r.id, revision: r.rev, kind: r.data.kind, name: r.data.name, content: r.data.content })), activity: await services.activity(req.account, 1000) })));

  api.get('/oauth/:id', wrap(async req => { const p = await auth.pending(String(req.params.id), req.account); return { client: p.client.name, scopes: p.params.scopes, redirectHost: new URL(p.params.redirectUri).host }; }));
  api.post('/oauth/:id', wrap(async req => { const redirect = await auth.decide(String(req.params.id), req.account, req.body.allow === true); services.hub(req.account).notify('assistants'); return { redirect }; }));

  const KINDS: DocKind[] = ['storyboard', 'tune', 'file', 'snapshot', 'build'];
  const content = (kind: DocKind, value: unknown) => {
    if (kind === 'storyboard') { const p = projectSchema.safeParse(value); if (!p.success) throw new ToolError('invalid', `That storyboard is not valid: ${p.error.issues[0].message}`); return p.data; }
    if (kind === 'file' && typeof value !== 'string') throw new ToolError('invalid', 'A file is text.');
    if (kind === 'build') { const b = buildSchema.safeParse(value); if (!b.success) throw new ToolError('invalid', `That build is not valid: ${b.error.issues[0].message}`); return b.data; }
    return value;
  };
  api.get('/docs', wrap(async req => (await services.docs(req.account)).map(r => ({ id: r.id, revision: r.rev, kind: r.data.kind, name: r.data.name, updatedBy: r.data.updatedBy, updatedAt: r.updatedAt, canUndo: r.data.history.length > 0 }))));
  api.post('/docs', wrap(async req => { const kind = req.body.kind as DocKind; if (!KINDS.includes(kind)) throw new ToolError('invalid', 'Unknown document kind.'); const row = await services.createDoc(req.account, kind, text(req.body.name, 80), content(kind, req.body.content), 'you'); return { id: row.id, revision: row.rev }; }));
  api.get('/docs/:id', wrap(async req => { const r = await services.doc(req.account, String(req.params.id)); return { id: r.id, revision: r.rev, kind: r.data.kind, name: r.data.name, content: r.data.content, updatedBy: r.data.updatedBy, updatedAt: r.updatedAt, canUndo: r.data.history.length > 0 }; }));
  api.put('/docs/:id', wrap(async req => { const current = await services.doc(req.account, String(req.params.id)); const row = await services.writeDoc(req.account, current.id, Number(req.body.baseRevision), content(current.data.kind, req.body.content), 'you', req.body.name === undefined ? undefined : text(req.body.name, 80)); return { id: row.id, revision: row.rev }; }));
  // A person's change to a build goes through the same operations an assistant uses.
  api.post('/docs/:id/ops', wrap(async req => {
    const current = await services.doc(req.account, String(req.params.id));
    if (current.data.kind !== 'build' || !Array.isArray(req.body.operations) || req.body.operations.length > 50) throw new ToolError('invalid', 'Send build operations for a build.');
    let next: Build;
    try { next = applyBuildOps(current.data.content as Build, req.body.operations, 'you'); } catch (error) { if (error instanceof BuildError) throw new ToolError('invalid', error.message, BUILD_OPS_HINT); throw error; }
    const row = await services.writeDoc(req.account, current.id, Number(req.body.baseRevision), next, 'you', req.body.name === undefined ? undefined : text(req.body.name, 80));
    return { id: row.id, revision: row.rev, content: row.data.content };
  }));
  api.post('/docs/:id/undo', wrap(async req => { const row = await services.undoDoc(req.account, String(req.params.id), 'you'); return { id: row.id, revision: row.rev }; }));
  api.delete('/docs/:id', wrap(async req => { await services.deleteDoc(req.account, String(req.params.id)); }));

  // Ratings of catalog parts, shared by everyone who uses Armable. One per person per part.
  api.put('/ratings/:part', wrap(async req => {
    const stars = Number(req.body.stars);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new ToolError('invalid', 'Give 1 to 5 stars.');
    const review = req.body.review === undefined || req.body.review === null ? undefined : text(req.body.review, 600);
    return services.rate(req.account, ratedPart(String(req.params.part)), stars, review);
  }));
  api.delete('/ratings/:part', wrap(async req => services.rate(req.account, ratedPart(String(req.params.part)), null)));

  api.get('/activity', wrap(async req => services.activity(req.account, 200)));
  api.post('/activity', wrap(async req => {
    const b = req.body;
    // A person's own change or test, made with a control in the interface, is tracked like an assistant's.
    const aircraft = services.currentAircraft(req.account);
    if (b.kind === 'change' && Array.isArray(b.detail?.changes))
      for (const c of b.detail.changes.slice(0, 24)) await tracker.settingChange({ account: req.account, aircraftId: aircraft, settingId: String(c.id).slice(0, 80), before: c.before, requested: c.requested, after: c.after, ok: c.ok === true, note: typeof c.note === 'string' ? c.note.slice(0, 300) : undefined, by: 'you' });
    if (b.kind === 'test' && typeof b.testId === 'string') await tracker.testRun({ account: req.account, aircraftId: aircraft, testId: b.testId.slice(0, 60), args: b.args, ok: typeof b.ok === 'boolean' ? b.ok : null, summary: typeof b.detail?.summary === 'string' ? b.detail.summary.slice(0, 600) : undefined, by: 'you' });
    await services.log(req.account, { who: 'you', kind: ['read', 'test', 'change', 'edit', 'connect', 'show'].includes(b.kind) ? b.kind : 'change', title: text(b.title, 160), part: typeof b.part === 'string' ? b.part.slice(0, 20) : undefined, ok: typeof b.ok === 'boolean' ? b.ok : b.ok === null ? null : undefined, ids: Array.isArray(b.ids) ? b.ids.slice(0, 24).map(String) : undefined, detail: b.detail });
  }));

  api.get('/grants', wrap(async req => services.grants(req.account)));
  api.post('/grants', wrap(async req => {
    const b = req.body ?? {};
    const list = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 20) : [];
    const conditions = list(b.conditions).filter(c => ['propsRemoved', 'directUsb', 'batteryConnected', 'batteryDisconnected', 'areaClear', 'level', 'still'].includes(c)) as Condition[];
    return services.createGrant(req.account, { parts: list(b.parts), tests: list(b.tests), minutes: Number(b.minutes), maxChanges: Number(b.maxChanges), conditions });
  }));
  api.delete('/grants/:id', wrap(async req => { await services.revokeGrant(req.account, String(req.params.id)); }));
  api.get('/data', wrap(async req => tracker.summary(req.account)));
  api.get('/data/:table', wrap(async req => {
    const table = String(req.params.table) as TrackTable;
    if (!TRACK_TABLES.includes(table)) throw new ToolError('not_found', 'No such table.');
    return tracker.list(table, req.account, Math.min(Number(req.query.limit ?? 200) || 200, 5000));
  }));
  api.get('/proposals', wrap(async req => (await services.proposals(req.account)).slice(0, 30)));
  // The decision route. It is reachable only with a person's session cookie; an assistant's token is never accepted here.
  api.post('/proposals/:id/decision', wrap(async req => services.decide(req.account, String(req.params.id), req.body.approve === true)));
  api.post('/proposals/:id/result', wrap(async req => { const r = req.body ?? {}; return services.complete(req.account, String(req.params.id), { ok: r.ok === true ? true : r.ok === false ? false : null, summary: text(r.summary ?? '', 600), changes: Array.isArray(r.changes) ? r.changes.slice(0, 24) : undefined, test: r.test }); }));

  // Fuller ArduPilot descriptions, fetched from the project's published metadata and cached. Best effort.
  const pdef = new Map<string, { at: number; body: unknown }>();
  api.get('/reference/ardupilot/:vehicle', wrap(async req => {
    const vehicle = ({ ArduCopter: 'ArduCopter', ArduPlane: 'ArduPlane', Rover: 'Rover' } as Record<string, string>)[String(req.params.vehicle)];
    if (!vehicle) throw new ToolError('not_found', 'Unknown vehicle.');
    const cached = pdef.get(vehicle);
    if (cached && Date.now() - cached.at < 86400_000) return cached.body;
    try {
      const response = await fetch(`https://autotest.ardupilot.org/Parameters/${vehicle}/apm.pdef.json`, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json();
      pdef.set(vehicle, { at: Date.now(), body });
      return body;
    } catch { throw new ToolError('unavailable', 'Parameter descriptions could not be fetched right now.'); }
  }));
  api.use((_req, res) => { res.status(404).json({ error: { code: 'not_found', message: 'No such route.' } }); });
  app.use('/api', api);

  // ---- The built interface -----------------------------------------------------------------------------------------

  // Setup instructions an agent can read and follow on its own (“Setup for agents”).
  app.get('/agent-onboarding/SKILL.md', (_req, res) => { res.type('text/markdown; charset=utf-8').set('Cache-Control', 'public, max-age=300').send(agentSkill(publicUrl)); });

  // ---- Sign in with Google -------------------------------------------------------------------------------------------

  const STATE = 'armable_google';
  const callback = new URL('/auth/google/callback', publicUrl).href;
  const safeNext = (next: unknown) => typeof next === 'string' && /^\/(?!\/)/.test(next) ? next : '/';
  app.get('/auth/google', (req, res) => {
    if (!options.google) { res.status(404).send('Google sign-in is not set up.'); return; }
    const state = `${randomBytes(16).toString('base64url')}.${Buffer.from(safeNext(req.query.next)).toString('base64url')}`;
    res.setHeader('Set-Cookie', cookie.serialize(STATE, state, { httpOnly: true, secure, sameSite: 'lax', path: '/auth/google', maxAge: 600 }));
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: options.google.clientId, redirect_uri: callback, response_type: 'code', scope: 'openid email', state, prompt: 'select_account' }).toString();
    res.redirect(url.href);
  });
  app.get('/auth/google/callback', limiter, async (req, res) => {
    const google = options.google;
    const state = cookie.parse(req.headers.cookie ?? '')[STATE];
    res.setHeader('Set-Cookie', cookie.serialize(STATE, '', { httpOnly: true, secure, sameSite: 'lax', path: '/auth/google', maxAge: 0 }));
    const fail = (why: string) => res.redirect(`/?signin=${encodeURIComponent(why)}`);
    if (!google || !state || req.query.state !== state || typeof req.query.code !== 'string') return fail('Google sign-in did not finish. Try again.');
    try {
      const response = await (google.fetch ?? fetch)('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(10_000),
        body: new URLSearchParams({ code: req.query.code, client_id: google.clientId, client_secret: google.clientSecret, redirect_uri: callback, grant_type: 'authorization_code' }) });
      const tokens = await response.json() as { id_token?: string };
      // The ID token came straight from Google over TLS, in exchange for our secret, so its claims can be read directly.
      const claims = tokens.id_token ? JSON.parse(Buffer.from(tokens.id_token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { iss?: string; aud?: string; sub?: string; email?: string; email_verified?: boolean; exp?: number } : undefined;
      if (!response.ok || !claims?.sub || !claims.email || claims.email_verified !== true || claims.aud !== google.clientId || !['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss ?? '') || (claims.exp ?? 0) * 1000 < Date.now()) return fail('Google did not confirm an email address.');
      const account = await auth.google({ sub: claims.sub, email: claims.email }, await auth.session(sessionToken(req)));
      setSession(res, await auth.startSession(account.id));
      res.redirect(safeNext(Buffer.from(state.split('.')[1] ?? '', 'base64url').toString('utf8')));
    } catch (error) { if (!options.quiet) console.error('[google]', error); fail('Google sign-in failed. Try again.'); }
  });

  const dir = options.staticDir && existsSync(options.staticDir) ? resolve(options.staticDir) : undefined;
  if (dir) {
    app.use(express.static(dir, { index: false, maxAge: '1h' }));
    const page = () => readFileSync(resolve(dir, 'index.html'), 'utf8');
    const escape = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
    // A shared build gets its own title and description, so the link previews well where it is posted.
    app.get('/b/:share', async (req, res) => {
      const share = await store.get<{ account: string; doc: string }>('shares', '_public', String(req.params.share)).catch(() => undefined);
      const doc = share && await store.get<{ kind: string; name: string; content: { items?: unknown[] } }>('docs', share.data.account, share.data.doc).catch(() => undefined);
      const title = doc?.data.kind === 'build' ? `${doc.data.name} · a drone build on Armable` : 'Armable';
      const description = doc?.data.kind === 'build' ? `${doc.data.content.items?.length ?? 0} parts, checked to work together, with prices and where to buy them.` : 'The drone bench your AI can use.';
      const head = `<title>${escape(title)}</title><meta property="og:title" content="${escape(title)}" /><meta property="og:description" content="${escape(description)}" /><meta name="description" content="${escape(description)}" />`;
      res.type('html').send(page().replace(/<title>[^<]*<\/title>/, head));
    });
    app.get(/^\/(?!api\/|mcp|live|\.well-known\/).*/, (_req, res) => res.sendFile(resolve(dir, 'index.html')));
  }

  // ---- The live channel to browser tabs ----------------------------------------------------------------------------

  const http: Server = createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  http.on('upgrade', (req, socket, head) => {
    void (async () => {
      const origin = req.headers.origin;
      const account = new URL(req.url ?? '/', publicUrl).pathname === '/live' && (!origin || new URL(origin).host === publicUrl.host || new URL(origin).hostname === 'localhost' || new URL(origin).hostname === '127.0.0.1') ? await auth.session(sessionToken(req)) : undefined;
      if (!account) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, ws => live(ws, account));
    })().catch(() => socket.destroy());
  });
  function live(ws: WebSocket, account: string) {
    const hub = services.hub(account);
    let tabId: string | undefined;
    const send = (message: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message)); };
    ws.on('message', raw => {
      let m: { type?: string; [key: string]: unknown };
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.type === 'hello' && typeof m.tab === 'string' && !tabId) {
        tabId = m.tab.slice(0, 40);
        hub.attach({ id: tabId, bench: false, active: Date.now(), send });
        void (async () => send({ type: 'event', event: 'hello', data: { mode: (await services.account(account))?.assistantMode ?? 'propose', proposals: (await services.proposals(account)).filter(p => p.status === 'awaiting_approval' || p.status === 'approved') } }))();
        return;
      }
      const tab = tabId ? hub.tabs.get(tabId) : undefined;
      if (!tab) return;
      tab.active = Date.now();
      if (m.type === 'mirror' && m.mirror && typeof m.mirror === 'object') {
        const mirror = m.mirror as Mirror;
        tab.bench = mirror.snapshot?.status !== 'idle';
        if (tab.bench) hub.mirror = { ...mirror, at: Date.now() };
        else if (!hub.benchTab()) hub.mirror = undefined;
        void services.observe(account, mirror).catch(error => { if (!options.quiet) console.error('[track]', error); });
      } else if (m.type === 'focus' && m.focus && typeof m.focus === 'object') hub.focus = { ...(m.focus as Focus), tab: tab.id, at: Date.now() };
      else if (m.type === 'reply' && typeof m.id === 'string') hub.settle(m.id, m.ok === true, m.payload);
    });
    ws.on('close', () => { if (tabId) hub.detach(tabId); });
    ws.on('error', () => ws.close());
  }
  const beat = setInterval(() => { for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.ping(); }, 25_000);
  http.on('close', () => clearInterval(beat));

  return { http, services, auth, app, async close() { clearInterval(beat); for (const ws of wss.clients) ws.terminate(); await new Promise<void>(r => http.close(() => r())); } };
}
