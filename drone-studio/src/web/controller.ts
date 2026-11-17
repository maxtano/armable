import { Bench, type ProposalLike } from '../bench/bench';
import { DeviceError } from '../device/bytes';
import { openWebUsbDfu } from '../device/flash/dfu';
import { fromPdef } from '../device/mavlink/meta';
import { Runtime } from '../device/runtime';
import { ardupilotDemo, betaflightDemo, type PortSource } from '../device/sim/demo';
import { WebSerialTransport } from '../device/transport';
import type { Change, Condition, PartId, PromptRequest, TestSpec } from '../device/types';
import { api, ApiError, Live, type ServerMessage } from './cloud';
import { captureView } from './capture';
import { clearMark, EMPTY_SNAP, get, mark, set, toast, type ProposalCard, type View } from './store';

/**
 * The one place that owns the drone connection in this tab. Every button calls a function here; every
 * request from an assistant arrives here too. Approval happens in `approve`, which is only ever called
 * from a click.
 */
export const runtime = new Runtime();
let live: Live | undefined;
let bench: Bench | undefined;

const partOfId = (id: string | undefined): string | undefined => {
  if (!id) return undefined;
  const s = get().settings.find(x => x.id === id);
  if (s) return s.part;
  const t = get().snap.tests.find(x => x.id === id);
  if (t) return t.part;
  const head = id.split('.')[0];
  return ({ battery: 'battery', gps: 'gps', rc: 'receiver', motor: 'motors', esc: 'motors', escs: 'motors', airframe: 'motors', attitude: 'fc', fc: 'fc', sensors: 'fc', link: 'link', arming: 'safety', log: 'logging' } as Record<string, string>)[head];
};
const PARTS = ['fc', 'motors', 'battery', 'receiver', 'gps', 'link', 'tuning', 'safety', 'osd', 'vtx', 'lights', 'ports', 'compass', 'logging'];
const VIEWS: View[] = ['drone', 'signals', 'flights', 'show', 'sound', 'settings', 'connect'];

export async function refreshMe() { const me = await api('GET', '/me'); set({ me }); return me; }
export async function refreshDocs() { set({ docs: await api('GET', '/docs') }); }

/** Start everything that needs a signed-in person. */
export async function start() {
  const me = await refreshMe();
  if (!me.signedIn) return;
  runtime.on(event => {
    if (event.type === 'progress') set({ progress: { label: event.label, done: event.done, total: event.total } });
    else if (event.type === 'settings') set({ settings: runtime.settings(), snap: runtime.snapshot(), log: runtime.lastLogAnalysis() });
    else set({ snap: runtime.snapshot() });
    if (event.type === 'status' && runtime.status === 'connected') void enrich();
  });
  live = new Live(onServer, open => set({ live: open }));
  bench = new Bench(runtime, { mirror: m => live!.mirror(m), reply: (id, ok, payload) => live!.send({ type: 'reply', id, ok, payload }) }, { capture: captureView });
  live.open();
  const [activity, proposals] = await Promise.all([api('GET', '/activity'), api('GET', '/proposals'), refreshDocs()]);
  void refreshGrants();
  set({ activity: activity.reverse(), proposals: proposals.filter((p: ProposalCard) => p.status === 'awaiting_approval' || p.status === 'approved') });
}
let focusTimer: ReturnType<typeof setTimeout> | undefined;
/** Tell the cloud what the person is looking at, so "this motor" means something to an assistant. */
export function publishFocus(extra: Record<string, unknown> = {}) {
  clearTimeout(focusTimer);
  focusTimer = setTimeout(() => { const s = get(); live?.send({ type: 'focus', focus: { route: s.view, part: s.part, selection: s.motor ? { motor: s.motor } : undefined, ...extra } }); }, 250);
}
export function go(view: View, part?: PartId, motor?: number) { set({ view, part, motor }); publishFocus(); }
export function select(part?: PartId, motor?: number) { set({ part, motor }); if (part) clearMark(part); publishFocus(); }

function onServer(message: ServerMessage) {
  if (message.type === 'rpc') {
    const request = message.request;
    // Show where the assistant is looking before answering it.
    const ids: string[] = request.op === 'refresh' ? request.ids : request.op === 'run' ? [request.id] : [];
    for (const id of ids.slice(0, 6)) { const part = partOfId(id); if (part) mark(part, 'reading', 'assistant'); }
    void bench!.handle(message.id, request);
    return;
  }
  const { event, data } = message;
  if (event === 'hello') set({ proposals: data.proposals ?? [], me: { ...get().me!, mode: data.mode } });
  else if (event === 'mode') set({ me: { ...get().me!, mode: data } });
  else if (event === 'assistants') void refreshMe();
  else if (event === 'activity') {
    set(s => ({ activity: [...s.activity.filter(a => a.id !== data.id), data].slice(-300) }));
    if (data.who !== 'you' && data.kind === 'read') for (const id of (data.ids ?? []).slice(0, 8)) { const part = partOfId(id); if (part) mark(part, 'reading', data.who); }
    if (data.who !== 'you' && data.part && get().follow && get().view !== 'drone' && data.kind !== 'edit') { /* quiet: the ribbon shows it */ }
  } else if (event === 'proposal') {
    const open = data.status === 'awaiting_approval' || data.status === 'approved';
    set(s => ({ proposals: [...s.proposals.filter(p => p.id !== data.id), ...(open ? [data] : [])] }));
    if (data.status === 'awaiting_approval' && get().follow) { go('drone', (data.part ?? partOfId(data.changes?.[0]?.id)) as PartId, motorOf(data)); toast(`${data.by} proposes a change`, 'info'); }
  } else if (event === 'document') { void refreshDocs(); set(s => ({ docRevision: s.docRevision + 1 })); if (data.by && data.by !== 'you') { mark(data.id, 'changed', data.by); toast(`${data.by} edited ${data.name ?? 'a document'}`, 'info'); } }
  else if (event === 'show') showTarget(String(data.target), data.reference);
  else if (event === 'grants') void refreshGrants();
  else if (event === 'execute') void executeUnderGrant(data);
}
const motorOf = (p: ProposalCard) => { const m = (p.changes?.[0]?.id ?? '').match(/^esc\.(\d+)\./); return m ? Number(m[1]) : p.test?.args?.motor ? Number(p.test.args.motor) : undefined; };
function showTarget(target: string, reference?: any) {
  if (reference) { set({ reference }); if (reference.part && get().follow) go('drone', reference.part); return; }
  if (!get().follow) { toast(`Assistant is pointing at ${target}`, 'info'); return; }
  if ((VIEWS as string[]).includes(target)) return go(target as View);
  if (PARTS.includes(target)) return go('drone', target as PartId);
  if (/^(show|tune|file|snap)_/.test(target)) return go(target.startsWith('show') ? 'show' : target.startsWith('tune') ? 'sound' : 'settings');
  const part = partOfId(target);
  const motor = target.match(/^esc\.(\d+)\./)?.[1];
  if (part) { go('drone', part as PartId, motor ? Number(motor) : undefined); mark(part, 'reading', 'assistant'); }
}

// ---- Connection ------------------------------------------------------------------------------------------------------

function usbSource(first: WebSerialTransport): PortSource {
  let pending: WebSerialTransport | undefined = first;
  const { vendorId, productId } = first.usb;
  return { label: first.label, demo: false, async open() {
    if (pending) { const t = pending; pending = undefined; return t; }
    // After a restart the same device comes back; the browser remembers that the person allowed it.
    const ports = await navigator.serial.getPorts();
    const port = ports.find(p => { const i = p.getInfo(); return i.usbVendorId === vendorId && i.usbProductId === productId; });
    if (!port) throw new DeviceError('disconnected', 'The flight controller is not back yet.');
    return WebSerialTransport.from(port);
  } };
}
async function connect(source: PortSource) {
  set({ busy: 'Connecting' });
  try {
    await runtime.connect(source);
    set({ snap: runtime.snapshot(), settings: [] });
    bench?.flush();
    void log('connect', `Connected ${runtime.snapshot().identity?.firmware ?? 'aircraft'}`, 'link', true);
    void loadSettings();
  } catch (error) { toast(words(error), 'bad'); }
  finally { set({ busy: undefined, progress: undefined }); }
}
/** Must be called from a click: the browser shows its own device chooser. */
export async function connectUsb() {
  if (!WebSerialTransport.supported()) return toast('Use Chrome or Edge on a computer to connect over USB.', 'bad');
  let transport: WebSerialTransport;
  try { transport = await WebSerialTransport.request(); } catch (error) { if ((error as Error).name !== 'NotFoundError') toast(words(error), 'bad'); return; }
  await connect(usbSource(transport));
}
export const connectDemo = (stack: 'ardupilot' | 'betaflight') => connect(stack === 'ardupilot' ? ardupilotDemo() : betaflightDemo());
export async function disconnect() { await runtime.disconnect(); set({ snap: EMPTY_SNAP, settings: [], log: undefined, part: undefined, motor: undefined }); bench?.flush(); }
export async function loadSettings() {
  try { await runtime.load(); } catch (error) { toast(words(error), 'bad'); }
  finally { set({ progress: undefined, settings: runtime.settings(), snap: runtime.snapshot() }); bench?.flush(); }
}
/** Fuller descriptions for ArduPilot settings, when the project's published metadata is reachable. */
async function enrich() {
  const id = runtime.snapshot().identity;
  const driver = runtime.driver as { applyMetadata?: (meta: unknown) => void } | undefined;
  if (id?.stack !== 'ardupilot' || !driver?.applyMetadata) return;
  try { driver.applyMetadata(fromPdef(await api('GET', `/reference/ardupilot/${id.firmware}`))); } catch { /* the built-in descriptions remain */ }
}

// ---- Doing things ----------------------------------------------------------------------------------------------------

export const words = (error: unknown) => error instanceof DeviceError || error instanceof ApiError ? (error.hint ? `${error.message} ${error.hint}` : error.message) : error instanceof Error ? error.message : 'Something went wrong.';
async function log(kind: string, title: string, part?: string, ok?: boolean | null, extra: Record<string, unknown> = {}) { await api('POST', '/activity', { kind, title, part, ok, ...extra }).catch(() => {}); }
const prompt = (request: PromptRequest) => new Promise<unknown>(resolve => set({ prompt: { request, resolve: value => { set({ prompt: undefined }); resolve(value); } } }));
/** Answer a prompt from a click. File bytes, a serial port, or a USB bootloader, depending on what was asked. */
export async function answerPrompt(input?: File | 'cancel') {
  const p = get().prompt;
  if (!p) return;
  try {
    if (input === 'cancel') return p.resolve(undefined);
    if (p.request.kind === 'file') return p.resolve(input instanceof File ? new Uint8Array(await input.arrayBuffer()) : undefined);
    if (p.request.kind === 'serial') return p.resolve(await WebSerialTransport.request());
    if (p.request.kind === 'dfu') return p.resolve(await openWebUsbDfu(await navigator.usb.requestDevice({ filters: [{ vendorId: 0x0483, productId: 0xdf11 }] })));
    p.resolve(true);
  } catch (error) { toast(words(error), 'bad'); p.resolve(undefined); }
}

/** The person's own change, made with a control in the interface. Same write path as an assistant's proposal. */
export async function applyChanges(changes: Change[], confirmed: Condition[] = []) {
  set({ busy: 'Writing' });
  try {
    const outcome = await bench!.execute({ id: 'manual', kind: 'change', needs: changes.some(c => c.id.startsWith('esc.')) ? ['propsRemoved', 'directUsb'] : [], changes }, confirmed, prompt);
    for (const c of outcome.changes ?? []) if (c.ok) { mark(c.id, 'changed', 'you'); const part = partOfId(c.id); if (part) mark(part, 'changed', 'you'); }
    toast(outcome.summary, outcome.ok ? 'ok' : 'bad');
    void log('change', changes.length === 1 ? `Changed ${get().settings.find(s => s.id === changes[0].id)?.title ?? changes[0].id}` : `Changed ${changes.length} settings`, partOfId(changes[0].id), outcome.ok, { ids: changes.map(c => c.id), detail: { summary: outcome.summary, changes: outcome.changes } });
    return outcome;
  } finally { set({ busy: undefined, progress: undefined, settings: runtime.settings(), snap: runtime.snapshot() }); }
}
/** The person runs a test or procedure themselves. */
export async function runTest(spec: TestSpec, args: Record<string, unknown> = {}, confirmed: Condition[] = []) {
  set({ busy: spec.name });
  try {
    const outcome = spec.level === 0
      ? await runtime.run(spec.id, args).then(test => ({ ok: test.ok, summary: test.summary, test }))
      : await bench!.execute({ id: 'manual', kind: 'test', needs: spec.needs, test: { id: spec.id, args } }, confirmed, prompt);
    toast(outcome.summary, outcome.ok === false ? 'bad' : outcome.ok ? 'ok' : 'info');
    if (spec.id === 'settings.snapshot' && (outcome.test?.data as { values?: unknown } | undefined)?.values) {
      const id = runtime.snapshot().identity;
      await api('POST', '/docs', { kind: 'snapshot', name: `${id?.craftName ?? id?.firmware ?? 'Aircraft'} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, content: outcome.test!.data });
      void refreshDocs();
    }
    void log('test', spec.name, spec.part, outcome.ok, { testId: spec.id, args, detail: { summary: outcome.summary } });
    return outcome;
  } catch (error) { toast(words(error), 'bad'); return { ok: false, summary: words(error) }; }
  finally { set({ busy: undefined, progress: undefined, settings: runtime.settings(), snap: runtime.snapshot(), log: runtime.lastLogAnalysis() }); bench?.flush(); }
}
export async function stopAll() { await runtime.stop(); toast('Stop sent', 'info'); void log('test', 'Stopped the motors', 'motors', null); }

/** The approve button. The decision is recorded with the person's session, then this tab does the work. */
export async function approve(card: ProposalCard, confirmed: Condition[]) {
  set({ busy: 'Applying' });
  try {
    const decided = await api('POST', `/proposals/${card.id}/decision`, { approve: true });
    const outcome = await bench!.execute(decided as ProposalLike, confirmed, prompt);
    await api('POST', `/proposals/${card.id}/result`, outcome);
    for (const c of outcome.changes ?? []) if (c.ok) { mark(c.id, 'changed', card.by); const part = partOfId(c.id); if (part) mark(part, 'changed', card.by); }
    toast(outcome.summary, outcome.ok === false ? 'bad' : 'ok');
  } catch (error) { toast(words(error), 'bad'); }
  finally { set(s => ({ busy: undefined, progress: undefined, settings: runtime.settings(), snap: runtime.snapshot(), proposals: s.proposals.filter(p => p.id !== card.id) })); }
}
export async function decline(card: ProposalCard) {
  await api('POST', `/proposals/${card.id}/decision`, { approve: false }).catch(() => {});
  set(s => ({ proposals: s.proposals.filter(p => p.id !== card.id) }));
}
/** A proposal your standing permission approved. This tab has the drone, so it carries it out and reports back. */
async function executeUnderGrant(card: ProposalCard & { grantConditions?: Condition[] }) {
  if (runtime.status !== 'connected') return;
  const outcome = await bench!.execute(card as ProposalLike, card.grantConditions ?? [], prompt);
  await api('POST', `/proposals/${card.id}/result`, outcome).catch(() => {});
  for (const c of outcome.changes ?? []) if (c.ok) { mark(c.id, 'changed', card.by); const part = partOfId(c.id); if (part) mark(part, 'changed', card.by); }
  toast(`${card.by}: ${outcome.summary} (your permission)`, outcome.ok === false ? 'bad' : 'ok');
  set(s => ({ settings: runtime.settings(), snap: runtime.snapshot(), proposals: s.proposals.filter(p => p.id !== card.id) }));
}
export async function refreshGrants() { set({ grants: await api('GET', '/grants').catch(() => []) }); }
export async function createGrant(input: { parts: string[]; tests: string[]; minutes: number; maxChanges: number; conditions: Condition[] }) {
  try { await api('POST', '/grants', input); await refreshGrants(); toast('Permission on', 'ok'); } catch (error) { toast(words(error), 'bad'); }
}
export async function revokeGrant(id: string) { await api('DELETE', `/grants/${id}`).catch(() => {}); await refreshGrants(); }
export async function setMode(mode: 'off' | 'observe' | 'propose') { await api('PUT', '/mode', { mode }); set({ me: { ...get().me!, mode } }); }
export async function signOut() { await api('POST', '/logout'); location.reload(); }
