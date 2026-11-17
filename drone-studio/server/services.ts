import type { RemoteRequest } from '../src/device/runtime';
import type { Change, ChangeResult, Condition, TestResult } from '../src/device/types';
import type { Mirror } from '../src/map/map';
import { ConflictError, newId, type Row, type Store } from './store';
import { aircraftId, MemoryTracker, type Tracker } from './tracker';

/** An error a tool can hand straight to an assistant: a code to branch on, words to relay, and what to do next. */
export class ToolError extends Error {
  constructor(readonly code: string, message: string, readonly hint?: string, readonly extra?: Record<string, unknown>) { super(message); }
}

export type AssistantMode = 'off' | 'observe' | 'propose';
export interface Account { id: string; email: string; passwordHash: string; createdAt: number; assistantMode: AssistantMode }
export type DocKind = 'storyboard' | 'tune' | 'file' | 'snapshot';
export interface Doc { kind: DocKind; name: string; content: unknown; updatedBy: string; history: { content: unknown; by: string; at: number }[] }
export interface ActivityEntry { at: number; who: string; kind: 'read' | 'test' | 'change' | 'edit' | 'proposal' | 'connect' | 'show'; title: string; part?: string; ids?: string[]; ok?: boolean | null; detail?: unknown }
export type ProposalStatus = 'awaiting_approval' | 'approved' | 'done' | 'failed' | 'rejected' | 'expired' | 'cancelled';
export interface Proposal {
  id: string; kind: 'change' | 'test'; by: string; reason?: string; level: 2 | 3;
  changes?: (Change & { title?: string; before?: unknown })[];
  test?: { id: string; name: string; args?: Record<string, unknown> };
  needs: Condition[]; part?: string;
  status: ProposalStatus; createdAt: number; expiresAt: number; decidedAt?: number;
  /** Set when a person's standing permission approved this without a click. */
  grant?: string;
  result?: { ok: boolean | null; summary: string; changes?: ChangeResult[]; test?: TestResult };
}
export interface Focus { tab: string; at: number; route?: string; part?: string; setting?: string; document?: string; selection?: unknown; playhead?: number }
export type TabMessage =
  | { type: 'rpc'; id: string; request: RemoteRequest | { op: 'capture'; view: string } }
  | { type: 'event'; event: string; data?: unknown };
interface Tab { id: string; send(message: TabMessage): void; bench: boolean; active: number }

const PROPOSAL_TTL = 10 * 60_000;
const TERMINAL: ProposalStatus[] = ['done', 'failed', 'rejected', 'expired', 'cancelled'];

/** Live, per-account state that is not worth persisting: open tabs, the mirror of the aircraft, pending calls. */
export class Hub {
  tabs = new Map<string, Tab>();
  mirror?: Mirror;
  focus?: Focus;
  /** Assistants seen recently, by name. */
  assistants = new Map<string, number>();
  private calls = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private waiters = new Map<string, Set<() => void>>();

  attach(tab: Tab) { this.tabs.set(tab.id, tab); }
  detach(id: string) {
    const tab = this.tabs.get(id);
    this.tabs.delete(id);
    if (tab?.bench && ![...this.tabs.values()].some(t => t.bench)) this.mirror = undefined;
    if (this.focus?.tab === id) this.focus = undefined;
  }
  benchTab(): Tab | undefined { return [...this.tabs.values()].filter(t => t.bench).sort((a, b) => b.active - a.active)[0]; }
  notify(event: string, data?: unknown) { for (const tab of this.tabs.values()) tab.send({ type: 'event', event, data }); }
  /** Ask the bench tab to do something on the aircraft. Only observe-level requests exist in this vocabulary. */
  call(request: RemoteRequest | { op: 'capture'; view: string }, timeoutMs = 30_000): Promise<unknown> {
    const tab = request.op === 'capture' ? [...this.tabs.values()].sort((a, b) => b.active - a.active)[0] : this.benchTab();
    if (!tab) return Promise.reject(new ToolError('no_bench', request.op === 'capture' ? 'Lucidity is not open in any browser tab.' : 'Lucidity is not open with a drone connected.', 'Ask the person to open Lucidity and connect the drone, then try again.'));
    const id = newId(6);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.calls.delete(id); reject(new ToolError('timeout', 'The Lucidity tab did not answer in time.', 'The tab may be in the background or the drone unplugged. Ask the person to bring Lucidity to the front.')); }, timeoutMs);
      this.calls.set(id, { resolve, reject, timer });
      tab.send({ type: 'rpc', id, request });
    });
  }
  settle(id: string, ok: boolean, payload: unknown) {
    const call = this.calls.get(id);
    if (!call) return;
    clearTimeout(call.timer);
    this.calls.delete(id);
    if (ok) call.resolve(payload);
    else { const e = payload as { code?: string; message?: string; hint?: string }; call.reject(new ToolError(e?.code ?? 'device_error', e?.message ?? 'The aircraft operation failed.', e?.hint)); }
  }
  wake(proposal: string) { for (const fn of this.waiters.get(proposal) ?? []) fn(); }
  untilWoken(proposal: string, ms: number): Promise<void> {
    return new Promise(resolve => {
      const set = this.waiters.get(proposal) ?? new Set();
      this.waiters.set(proposal, set);
      const done = () => { clearTimeout(timer); set.delete(done); resolve(); };
      const timer = setTimeout(done, ms);
      set.add(done);
    });
  }
}

const TELEMETRY_EVERY_MS = 10_000;
export class Services {
  private hubs = new Map<string, Hub>();
  private seen = new Map<string, { status: string; aircraft?: string; telemetryAt: number }>();
  constructor(readonly store: Store, readonly now: () => number = Date.now, readonly tracker: Tracker = new MemoryTracker()) {}
  /** The tracked id of the aircraft this account has connected right now, if any. */
  currentAircraft(account: string): string | undefined {
    const identity = this.hub(account).mirror?.snapshot.identity;
    return identity && this.hub(account).mirror?.snapshot.status === 'connected' ? aircraftId(account, identity) : undefined;
  }
  /** Called with each mirror from a bench tab: records aircraft, connections and a telemetry sample every few seconds. */
  async observe(account: string, mirror: { snapshot: { status: string; identity?: import('../src/device/types').Identity; label?: string; demo?: boolean; state?: import('../src/device/types').LiveState } }) {
    const s = mirror.snapshot, last = this.seen.get(account) ?? { status: 'idle', telemetryAt: 0 };
    let aircraft = last.aircraft;
    if (s.status === 'connected' && s.identity) aircraft = s.identity.version === 'unknown' && last.aircraft ? last.aircraft : await this.tracker.aircraft(account, s.identity, !!s.demo);
    if (s.status !== last.status && (s.status === 'connected' || s.status === 'reconnecting' || (s.status === 'idle' && last.status !== 'idle')))
      await this.tracker.connection(account, s.status === 'idle' ? last.aircraft : aircraft, s.status === 'idle' ? 'disconnected' : s.status as 'connected' | 'reconnecting', s.label);
    let telemetryAt = last.telemetryAt;
    if (s.status === 'connected' && aircraft && s.state && this.now() - telemetryAt >= TELEMETRY_EVERY_MS) { telemetryAt = this.now(); await this.tracker.telemetry(account, aircraft, s.state); }
    this.seen.set(account, { status: s.status, aircraft: s.status === 'idle' ? undefined : aircraft, telemetryAt });
  }
  hub(account: string): Hub { let hub = this.hubs.get(account); if (!hub) this.hubs.set(account, hub = new Hub()); return hub; }

  // ---- Accounts -------------------------------------------------------------------------------------------------

  async account(id: string): Promise<Account | undefined> { return (await this.store.get<Account>('accounts', '', id))?.data; }
  async setMode(account: string, mode: AssistantMode) {
    const row = await this.store.get<Account>('accounts', '', account);
    if (!row) throw new ToolError('not_found', 'Account not found.');
    await this.store.put('accounts', '', account, { ...row.data, assistantMode: mode });
    if (mode === 'off') for (const p of await this.proposals(account)) if (p.status === 'awaiting_approval') await this.finish(account, p.id, 'cancelled', { ok: false, summary: 'Assistants were switched off.' });
    this.hub(account).notify('mode', mode);
  }

  // ---- Activity -------------------------------------------------------------------------------------------------

  async log(account: string, entry: Omit<ActivityEntry, 'at'>) {
    const row = await this.store.append<ActivityEntry>('activity', account, { ...entry, at: this.now() });
    this.hub(account).notify('activity', { id: row.id, ...row.data });
    return row;
  }
  async activity(account: string, limit = 50) { return (await this.store.list<ActivityEntry>('activity', account, limit)).map(r => ({ id: r.id, ...r.data })); }

  // ---- Documents ------------------------------------------------------------------------------------------------

  async docs(account: string, kind?: DocKind) { return (await this.store.list<Doc>('docs', account, 200)).filter(r => !kind || r.data.kind === kind); }
  async doc(account: string, id: string): Promise<Row<Doc>> {
    const row = await this.store.get<Doc>('docs', account, id);
    if (!row) throw new ToolError('not_found', `There is no document "${id}".`, 'Use find, or get_workspace, to list documents.');
    return row;
  }
  async createDoc(account: string, kind: DocKind, name: string, content: unknown, by: string): Promise<Row<Doc>> {
    const prefix = { storyboard: 'show', tune: 'tune', file: 'file', snapshot: 'snap' }[kind];
    const row = await this.store.put<Doc>('docs', account, `${prefix}_${newId(6)}`, { kind, name: name.slice(0, 80), content, updatedBy: by, history: [] }, { expectedRev: 0 });
    this.hub(account).notify('document', { id: row.id, rev: row.rev, kind, name: row.data.name, by });
    return row;
  }
  /** Replace a document's content, based on a revision. A stale base is refused with the current revision attached. */
  async writeDoc(account: string, id: string, baseRev: number, content: unknown, by: string, rename?: string): Promise<Row<Doc>> {
    const current = await this.doc(account, id);
    if (current.rev !== baseRev) throw new ToolError('stale', `"${current.data.name}" is at revision ${current.rev}, not ${baseRev}.`, 'Read it again and base the edit on the current revision.', { currentRevision: current.rev, lastEditedBy: current.data.updatedBy });
    const history = current.data.kind === 'snapshot' ? [] : [...current.data.history, { content: current.data.content, by: current.data.updatedBy, at: current.updatedAt }].slice(-20);
    try {
      const row = await this.store.put<Doc>('docs', account, id, { ...current.data, name: rename?.slice(0, 80) ?? current.data.name, content, updatedBy: by, history }, { expectedRev: baseRev });
      this.hub(account).notify('document', { id, rev: row.rev, kind: row.data.kind, name: row.data.name, by });
      return row;
    } catch (error) {
      if (error instanceof ConflictError) throw new ToolError('stale', 'Someone else edited this at the same moment.', 'Read it again and retry.', { currentRevision: error.current?.rev });
      throw error;
    }
  }
  /** Undo the caller's own last edit. Someone else's edit is never undone on their behalf. */
  async undoDoc(account: string, id: string, by: string): Promise<Row<Doc>> {
    const current = await this.doc(account, id);
    const last = current.data.history.at(-1);
    if (!last) throw new ToolError('nothing_to_undo', 'There is nothing to undo.');
    if (current.data.updatedBy !== by) throw new ToolError('not_yours', `The last edit was made by ${current.data.updatedBy}, not ${by}.`, 'Only the person who made an edit can undo it.');
    const row = await this.store.put<Doc>('docs', account, id, { ...current.data, content: last.content, updatedBy: last.by, history: current.data.history.slice(0, -1) }, { expectedRev: current.rev });
    this.hub(account).notify('document', { id, rev: row.rev, kind: row.data.kind, name: row.data.name, by });
    return row;
  }
  async deleteDoc(account: string, id: string) { await this.store.delete('docs', account, id); this.hub(account).notify('document', { id, deleted: true }); }

  // ---- Proposals ------------------------------------------------------------------------------------------------

  private async expire(account: string, row: Row<Proposal>): Promise<Proposal> {
    if (row.data.status === 'awaiting_approval' && this.now() > row.data.expiresAt) return this.finish(account, row.id, 'expired', { ok: false, summary: 'Nobody approved it in time.' });
    return row.data;
  }
  async proposals(account: string): Promise<Proposal[]> { return Promise.all((await this.store.list<Proposal>('proposals', account, 50)).map(r => this.expire(account, r))); }
  async proposal(account: string, id: string): Promise<Proposal> {
    const row = await this.store.get<Proposal>('proposals', account, id);
    if (!row) throw new ToolError('not_found', `There is no proposal "${id}".`);
    return this.expire(account, row);
  }
  async propose(account: string, input: Omit<Proposal, 'id' | 'status' | 'createdAt' | 'expiresAt'>): Promise<Proposal> {
    const id = `prop_${newId(6)}`;
    const proposal: Proposal = { ...input, id, status: 'awaiting_approval', createdAt: this.now(), expiresAt: this.now() + PROPOSAL_TTL };
    await this.store.put('proposals', account, id, proposal, { expectedRev: 0 });
    void this.trackProposal(account, proposal);
    this.hub(account).notify('proposal', proposal);
    await this.log(account, { who: input.by, kind: 'proposal', part: input.part, ids: input.changes?.map(c => c.id), title: input.kind === 'change' ? `Proposed ${input.changes!.length === 1 ? input.changes![0].title ?? input.changes![0].id : `${input.changes!.length} changes`}` : `Asked to run ${input.test!.name}`, detail: { proposal: id } });
    return proposal;
  }
  private async finish(account: string, id: string, status: ProposalStatus, result?: Proposal['result']): Promise<Proposal> {
    const row = await this.store.get<Proposal>('proposals', account, id);
    if (!row) throw new ToolError('not_found', `There is no proposal "${id}".`);
    if (TERMINAL.includes(row.data.status)) return row.data;
    const next: Proposal = { ...row.data, status, result: result ?? row.data.result, decidedAt: row.data.decidedAt ?? this.now() };
    await this.store.put('proposals', account, id, next);
    void this.trackProposal(account, next);
    const hub = this.hub(account);
    hub.notify('proposal', next);
    hub.wake(id);
    return next;
  }
  /**
   * A person's decision. This is called only from the signed-in browser route, never from a tool.
   * Approval does not execute anything: the bench tab does that, and reports back through `complete`.
   */
  async decide(account: string, id: string, approve: boolean): Promise<Proposal> {
    const current = await this.proposal(account, id);
    if (current.status !== 'awaiting_approval') throw new ToolError('not_pending', `This proposal is ${current.status.replace('_', ' ')}.`);
    if (!approve) return this.finish(account, id, 'rejected', { ok: false, summary: 'The person declined.' });
    const next: Proposal = { ...current, status: 'approved', decidedAt: this.now() };
    await this.store.put('proposals', account, id, next);
    void this.trackProposal(account, next);
    this.hub(account).notify('proposal', next);
    return next;
  }
  /** The bench tab reports what happened. Accepted only for a proposal a person approved. */
  async complete(account: string, id: string, result: NonNullable<Proposal['result']>): Promise<Proposal> {
    const current = await this.proposal(account, id);
    if (current.status !== 'approved') throw new ToolError('not_approved', 'A result can only be recorded for a proposal the person approved.');
    const done = await this.finish(account, id, result.ok === false ? 'failed' : 'done', result);
    const aircraft = this.currentAircraft(account);
    for (const c of result.changes ?? []) await this.tracker.settingChange({ account, aircraftId: aircraft, settingId: c.id, before: c.before, requested: c.requested, after: c.after, ok: c.ok, note: c.note, by: current.by, proposalId: id });
    if (current.kind === 'test') await this.tracker.testRun({ account, aircraftId: aircraft, testId: current.test!.id, args: current.test!.args, ok: result.ok, summary: result.summary, by: current.by, proposalId: id });
    await this.log(account, {
      who: 'you', kind: current.kind === 'change' ? 'change' : 'test', part: current.part, ok: result.ok, ids: current.changes?.map(c => c.id),
      title: current.kind === 'change' ? `Approved ${current.by}'s change` : `Ran ${current.test!.name} for ${current.by}`, detail: { proposal: id, summary: result.summary, changes: result.changes },
    });
    return done;
  }
  private trackProposal(account: string, p: Proposal) {
    return this.tracker.proposal({ proposalId: p.id, account, assistant: p.by, kind: p.kind, status: p.status, level: p.level, needs: p.needs, reason: p.reason,
      changes: p.changes, test: p.test, result: p.result, grantId: p.grant, aircraftId: this.currentAircraft(account) });
  }
  async cancel(account: string, id: string, by: string): Promise<Proposal> {
    const current = await this.proposal(account, id);
    if (current.status !== 'awaiting_approval') return current;
    return this.finish(account, id, 'cancelled', { ok: false, summary: `Withdrawn by ${by}.` });
  }
  /** Hold until a proposal reaches an end state, or until the wait runs out. */
  async wait(account: string, id: string, ms: number): Promise<Proposal> {
    const end = this.now() + ms;
    for (;;) {
      const p = await this.proposal(account, id);
      if (TERMINAL.includes(p.status) || this.now() >= end) return p;
      await this.hub(account).untilWoken(id, Math.min(end - this.now(), 5000));
    }
  }
}
