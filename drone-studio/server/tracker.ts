import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { Identity, LiveState } from '../src/device/types';

/**
 * Records what happened, in plain tables, for history and analysis. Writes never block or break the request
 * they describe: a tracking failure is logged and dropped.
 */
export interface ToolCallEvent { /** When the call started, ms since epoch. */ startedAt?: number; account: string; assistant: string; clientId?: string; tool: string; input: unknown; ok: boolean; errorCode?: string; output?: unknown; durationMs: number; aircraftId?: string }
export interface ProposalEvent { proposalId: string; account: string; assistant?: string; kind: string; status: string; level?: number; needs?: string[]; reason?: string; changes?: unknown; test?: unknown; result?: unknown; grantId?: string; aircraftId?: string }
export interface SettingChangeEvent { account: string; aircraftId?: string; settingId: string; before: unknown; requested: unknown; after: unknown; ok: boolean; note?: string; by: string; proposalId?: string }
export interface TestRunEvent { account: string; aircraftId?: string; testId: string; args?: unknown; ok: boolean | null; summary?: string; by: string; proposalId?: string }
export type TrackTable = 'aircraft' | 'aircraft_connections' | 'tool_calls' | 'proposal_events' | 'setting_changes' | 'test_runs' | 'telemetry_samples';
export const TRACK_TABLES: TrackTable[] = ['aircraft', 'aircraft_connections', 'tool_calls', 'proposal_events', 'setting_changes', 'test_runs', 'telemetry_samples'];

export interface Tracker {
  /** Record an aircraft and return its id. Same account and identity give the same id. */
  aircraft(account: string, identity: Identity, demo: boolean): Promise<string>;
  connection(account: string, aircraftId: string | undefined, event: 'connected' | 'disconnected' | 'reconnecting', port?: string): Promise<void>;
  telemetry(account: string, aircraftId: string, state: LiveState): Promise<void>;
  toolCall(e: ToolCallEvent): Promise<void>;
  proposal(e: ProposalEvent): Promise<void>;
  settingChange(e: SettingChangeEvent): Promise<void>;
  testRun(e: TestRunEvent): Promise<void>;
  /** Newest first. */
  list(table: TrackTable, account: string, limit?: number): Promise<Record<string, unknown>[]>;
  summary(account: string): Promise<Record<string, number>>;
  deleteAccount(account: string): Promise<void>;
}

const OUTPUT_LIMIT = 8192;
export function clip(value: unknown): { json: unknown; bytes: number } {
  if (value === undefined) return { json: null, bytes: 0 };
  const text = JSON.stringify(value) ?? 'null';
  if (text.length <= OUTPUT_LIMIT) return { json: value, bytes: text.length };
  return { json: { truncated: true, preview: text.slice(0, OUTPUT_LIMIT - 200) }, bytes: text.length };
}
export const identityKey = (i: Identity) => i.uid ? `uid:${i.uid}` : `${i.stack}:${i.board ?? '?'}:${i.craftName ?? '?'}`;
export const aircraftId = (account: string, i: Identity) => `ac_${createHash('sha256').update(`${account}\u0000${identityKey(i)}`).digest('base64url').slice(0, 16)}`;
const sample = (s: LiveState) => ({
  armed: s.armed, mode: s.mode, voltage: s.battery?.voltage ?? null, current: s.battery?.current ?? null, remaining: s.battery?.remaining ?? null, cells: s.battery?.cells ?? null,
  rssi: s.rc?.rssi ?? null, gps_fix: s.gps?.fix ?? null, sats: s.gps?.sats ?? null, roll: s.attitude?.roll ?? null, pitch: s.attitude?.pitch ?? null, cpu_load: s.cpuLoad ?? null,
});

export class MemoryTracker implements Tracker {
  tables: Record<TrackTable, Record<string, unknown>[]> = { aircraft: [], aircraft_connections: [], tool_calls: [], proposal_events: [], setting_changes: [], test_runs: [], telemetry_samples: [] };
  private seq = 0;
  private add(table: TrackTable, row: Record<string, unknown>) { this.tables[table].push({ id: ++this.seq, at: new Date().toISOString(), ...row }); }
  async aircraft(account: string, i: Identity, demo: boolean) {
    const id = aircraftId(account, i);
    const existing = this.tables.aircraft.find(r => r.id === id);
    const row = { id, account, identity: identityKey(i), stack: i.stack, firmware: i.firmware, version: i.version, board: i.board ?? null, craft_name: i.craftName ?? null, demo, last_seen: new Date().toISOString() };
    if (existing) Object.assign(existing, row); else this.tables.aircraft.push({ ...row, first_seen: row.last_seen });
    return id;
  }
  async connection(account: string, aircraft_id: string | undefined, event: string, port?: string) { this.add('aircraft_connections', { account, aircraft_id: aircraft_id ?? null, event, port: port ?? null }); }
  async telemetry(account: string, aircraft_id: string, s: LiveState) { this.add('telemetry_samples', { account, aircraft_id, ...sample(s) }); }
  async toolCall(e: ToolCallEvent) { const out = clip(e.output); this.add('tool_calls', { ...(e.startedAt ? { at: new Date(e.startedAt).toISOString() } : {}), account: e.account, assistant: e.assistant, client_id: e.clientId ?? null, tool: e.tool, input: e.input, ok: e.ok, error_code: e.errorCode ?? null, output: out.json, output_bytes: out.bytes, duration_ms: e.durationMs, aircraft_id: e.aircraftId ?? null }); }
  async proposal(e: ProposalEvent) { this.add('proposal_events', { proposal_id: e.proposalId, account: e.account, assistant: e.assistant ?? null, kind: e.kind, status: e.status, level: e.level ?? null, needs: e.needs ?? null, reason: e.reason ?? null, changes: e.changes ?? null, test: e.test ?? null, result: e.result ?? null, grant_id: e.grantId ?? null, aircraft_id: e.aircraftId ?? null }); }
  async settingChange(e: SettingChangeEvent) { this.add('setting_changes', { account: e.account, aircraft_id: e.aircraftId ?? null, setting_id: e.settingId, before: e.before ?? null, requested: e.requested ?? null, after: e.after ?? null, ok: e.ok, note: e.note ?? null, by_who: e.by, proposal_id: e.proposalId ?? null }); }
  async testRun(e: TestRunEvent) { this.add('test_runs', { account: e.account, aircraft_id: e.aircraftId ?? null, test_id: e.testId, args: e.args ?? null, ok: e.ok, summary: e.summary ?? null, by_who: e.by, proposal_id: e.proposalId ?? null }); }
  async list(table: TrackTable, account: string, limit = 100) { return this.tables[table].filter(r => r.account === account).slice(-limit).reverse(); }
  async summary(account: string) { return Object.fromEntries(TRACK_TABLES.map(t => [t, this.tables[t].filter(r => r.account === account).length])); }
  async deleteAccount(account: string) { for (const t of TRACK_TABLES) this.tables[t] = this.tables[t].filter(r => r.account !== account); }
}

export class PgTracker implements Tracker {
  constructor(private pool: Pool, private onError: (error: unknown) => void = e => console.error('[tracker]', e)) {}
  private async q(sql: string, params: unknown[]) { try { await this.pool.query(sql, params); } catch (error) { this.onError(error); } }
  private j = (v: unknown) => v === undefined ? null : JSON.stringify(v);
  async aircraft(account: string, i: Identity, demo: boolean) {
    const id = aircraftId(account, i);
    await this.q(`insert into aircraft (id, account, identity, stack, firmware, version, board, craft_name, demo) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      on conflict (id) do update set firmware = excluded.firmware, version = excluded.version, board = excluded.board, craft_name = excluded.craft_name, last_seen = now()`,
      [id, account, identityKey(i), i.stack, i.firmware, i.version, i.board ?? null, i.craftName ?? null, demo]);
    return id;
  }
  connection(account: string, aircraftId: string | undefined, event: string, port?: string) {
    return this.q('insert into aircraft_connections (account, aircraft_id, event, port) values ($1,$2,$3,$4)', [account, aircraftId ?? null, event, port ?? null]);
  }
  telemetry(account: string, aircraftId: string, s: LiveState) {
    const x = sample(s);
    return this.q(`insert into telemetry_samples (account, aircraft_id, armed, mode, voltage, current, remaining, cells, rssi, gps_fix, sats, roll, pitch, cpu_load)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [account, aircraftId, x.armed, x.mode, x.voltage, x.current, x.remaining, x.cells, x.rssi, x.gps_fix, x.sats, x.roll, x.pitch, x.cpu_load]);
  }
  toolCall(e: ToolCallEvent) {
    const out = clip(e.output);
    return this.q(`insert into tool_calls (account, assistant, client_id, tool, input, ok, error_code, output, output_bytes, duration_ms, aircraft_id, at)
      values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9,$10,(select id from aircraft where id = $11),coalesce(to_timestamp($12::double precision / 1000), now()))`,
      [e.account, e.assistant, e.clientId ?? null, e.tool, this.j(e.input ?? {}), e.ok, e.errorCode ?? null, this.j(out.json), out.bytes, Math.round(e.durationMs), e.aircraftId ?? null, e.startedAt ?? null]);
  }
  proposal(e: ProposalEvent) {
    return this.q(`insert into proposal_events (proposal_id, account, assistant, kind, status, level, needs, reason, changes, test, result, grant_id, aircraft_id)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,(select id from aircraft where id = $13))`,
      [e.proposalId, e.account, e.assistant ?? null, e.kind, e.status, e.level ?? null, e.needs ?? null, e.reason ?? null, this.j(e.changes), this.j(e.test), this.j(e.result), e.grantId ?? null, e.aircraftId ?? null]);
  }
  settingChange(e: SettingChangeEvent) {
    return this.q(`insert into setting_changes (account, aircraft_id, setting_id, before, requested, after, ok, note, by_who, proposal_id)
      values ($1,(select id from aircraft where id = $2),$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9,$10)`,
      [e.account, e.aircraftId ?? null, e.settingId, this.j(e.before), this.j(e.requested), this.j(e.after), e.ok, e.note ?? null, e.by, e.proposalId ?? null]);
  }
  testRun(e: TestRunEvent) {
    return this.q(`insert into test_runs (account, aircraft_id, test_id, args, ok, summary, by_who, proposal_id) values ($1,(select id from aircraft where id = $2),$3,$4::jsonb,$5,$6,$7,$8)`,
      [e.account, e.aircraftId ?? null, e.testId, this.j(e.args), e.ok, e.summary ?? null, e.by, e.proposalId ?? null]);
  }
  async list(table: TrackTable, account: string, limit = 100) {
    if (!TRACK_TABLES.includes(table)) throw new Error('Unknown table.');
    const order = table === 'aircraft' ? 'last_seen desc' : table === 'tool_calls' ? 'at desc, id desc' : 'id desc';
    return (await this.pool.query(`select * from ${table} where account = $1 order by ${order} limit $2`, [account, Math.min(Math.max(limit, 1), 5000)])).rows;
  }
  async summary(account: string) {
    const parts = TRACK_TABLES.map(t => `(select count(*) from ${t} where account = $1)::int as ${t}`).join(', ');
    return (await this.pool.query(`select ${parts}`, [account])).rows[0] as Record<string, number>;
  }
  async deleteAccount(account: string) {
    for (const t of [...TRACK_TABLES].reverse()) await this.pool.query(`delete from ${t} where account = $1`, [account]);
  }
}
