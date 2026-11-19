import type { Mirror } from '../map/map';

/** The browser's link to the Armable cloud: a small JSON API and one WebSocket. */
export class ApiError extends Error { constructor(readonly code: string, message: string, readonly hint?: string, readonly extra: Record<string, unknown> = {}) { super(message); } }
export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, { method, credentials: 'same-origin', headers: method === 'GET' ? {} : { 'x-armable': '1', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await response.json().catch(() => undefined);
  if (!response.ok) { const e = json?.error ?? {}; throw new ApiError(e.code ?? 'error', e.message ?? 'Something went wrong.', e.hint, e); }
  return json as T;
}

export type ServerMessage = { type: 'rpc'; id: string; request: any } | { type: 'event'; event: string; data?: any };
/**
 * One WebSocket that reconnects on its own. Messages sent while it is down are dropped, except the latest mirror.
 * `surface` tells the server which workspace this tab is, so requests about the aircraft only ever reach the bench.
 */
export class Live {
  private ws?: WebSocket;
  private closed = false;
  private retry = 500;
  private lastMirror?: Mirror;
  readonly tab = `tab_${Math.random().toString(36).slice(2, 10)}`;
  constructor(private surface: 'bench' | 'show', private onMessage: (message: ServerMessage) => void, private onState: (open: boolean) => void) {}
  open() {
    if (this.closed || this.ws) return;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/live`);
    this.ws = ws;
    ws.onopen = () => { this.retry = 500; ws.send(JSON.stringify({ type: 'hello', tab: this.tab, surface: this.surface })); if (this.lastMirror) ws.send(JSON.stringify({ type: 'mirror', mirror: this.lastMirror })); this.onState(true); };
    ws.onmessage = event => { try { this.onMessage(JSON.parse(String(event.data))); } catch { /* ignore a malformed frame */ } };
    ws.onclose = () => { this.ws = undefined; this.onState(false); if (!this.closed) setTimeout(() => this.open(), this.retry = Math.min(this.retry * 2, 8000)); };
    ws.onerror = () => ws.close();
  }
  close() { this.closed = true; this.ws?.close(); }
  send(message: Record<string, unknown>) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message)); }
  mirror(mirror: Mirror) { this.lastMirror = mirror; this.send({ type: 'mirror', mirror }); }
}

/** Things the person did while offline, kept until the server can take them. */
const OUTBOX = 'armable.outbox.v1';
export function queue(method: string, path: string, body: unknown) {
  try { const list = JSON.parse(localStorage.getItem(OUTBOX) ?? '[]'); list.push({ method, path, body, at: Date.now() }); localStorage.setItem(OUTBOX, JSON.stringify(list.slice(-500))); } catch { /* storage unavailable */ }
}
export async function flushOutbox(): Promise<number> {
  let list: { method: string; path: string; body: unknown }[];
  try { list = JSON.parse(localStorage.getItem(OUTBOX) ?? '[]'); } catch { return 0; }
  let sent = 0;
  while (list.length) {
    try { await api(list[0].method, list[0].path, list[0].body); } catch (error) { if (error instanceof TypeError) break; }
    list.shift(); sent++;
    try { localStorage.setItem(OUTBOX, JSON.stringify(list)); } catch { /* storage unavailable */ }
  }
  return sent;
}
/** True when the request failed because there is no network, not because the server said no. */
export const offlineError = (error: unknown) => error instanceof TypeError || (typeof navigator !== 'undefined' && navigator.onLine === false);
