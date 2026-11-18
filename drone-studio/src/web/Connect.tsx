import { useState } from 'react';
import { Check, Copy, Eye, PencilRuler, Unplug, Wrench } from 'lucide-react';
import { api } from './cloud';
import { ConnectMenu } from './ConnectMenu';
import { createGrant, refreshMe, revokeGrant, setMode } from './controller';
import { Conditions } from './controls';
import { PART_NAME } from './parts';
import type { Condition, PartId } from '../device/types';
import { toast, useStore, type AssistantMode } from './store';

const TOOLS: [string, string][] = [
  ['get_workspace', 'Where things stand'], ['find', 'Search everything, and parts'], ['read', 'Read values'], ['run_test', 'Run a check'], ['propose_change', 'Propose a change'], ['wait', 'Wait for you'],
  ['edit', 'Edit a document or build'], ['undo', 'Undo its edit'], ['show', 'Point at something'], ['capture_view', 'See the screen'], ['stop', 'Stop'],
];
const SCOPE: Record<string, [typeof Eye, string]> = { observe: [Eye, 'Read your drone'], design: [PencilRuler, 'Edit shows and sounds'], propose: [Wrench, 'Propose changes'] };

export function ModeSwitch() {
  const mode = useStore(s => s.me?.mode ?? 'observe');
  const options: [AssistantMode, string][] = [['off', 'Off'], ['observe', 'Observe'], ['propose', 'Propose']];
  return <div className="lu-segments is-mode" role="radiogroup" aria-label="What assistants may do">{options.map(([value, label]) => <button key={value} role="radio" aria-checked={mode === value} onClick={() => setMode(value)}>{label}</button>)}</div>;
}

const MODE_HINT: Record<AssistantMode, string> = {
  off: 'Off: assistants can’t see or do anything here.',
  observe: 'Observe: assistants read your drone and help with builds and shows, but can’t change your drone. The demo drone accepts changes either way.',
  propose: 'Propose: assistants can also suggest changes to your drone. Nothing happens until you approve each one here.',
};

/** Connect your own assistant: one address to paste, then sign in. */
export function Connect() {
  const me = useStore(s => s.me), [copied, setCopied] = useState(false);
  const copy = async () => { await navigator.clipboard.writeText(me?.mcpUrl ?? '').catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  const remove = async (clientId: string) => { await api('DELETE', `/assistants/${clientId}`); await refreshMe(); toast('Disconnected', 'info'); };
  return (
    <section className="lu-page is-narrow">
      <header className="lu-page-head"><h1>Your assistant</h1><ModeSwitch /></header>
      <p className="lu-hint lu-mode-hint">{MODE_HINT[me?.mode ?? 'observe']}</p>
      <div className="lu-connect-row"><ConnectMenu /><span className="lu-hint">One click for your assistant, or follow the three steps.</span></div>
      <ol className="lu-steps">
        <li><b>1</b><div><h3>Copy this address</h3><button className="lu-address" onClick={copy} aria-label="Copy the address">{me?.mcpUrl}<span>{copied ? <Check size={15} /> : <Copy size={15} />}</span></button></div></li>
        <li><b>2</b><div><h3>Add it in your assistant</h3><p>Claude: Settings → Connectors → Add custom connector.<br />ChatGPT: Settings → Connectors → Create.</p></div></li>
        <li><b>3</b><div><h3>Sign in when asked</h3><p>Then say: “Check my drone.”</p></div></li>
      </ol>
      <h2 className="lu-sub">Connected</h2>
      {me?.assistants?.length ? (
        <ul className="lu-assistants">{me.assistants.map(a => (
          <li key={a.clientId}><b>{a.name}</b><span>{a.scopes.map(s => SCOPE[s]?.[1] ?? s).join(' · ')}</span><button className="lu-btn" onClick={() => remove(a.clientId)}><Unplug size={14} /> Disconnect</button></li>
        ))}</ul>
      ) : <p className="lu-hint">None yet</p>}
      <Permissions />
      <h2 className="lu-sub">What it can use</h2>
      <ul className="lu-tools">{TOOLS.map(([name, what]) => <li key={name}><code>{name}</code><span>{what}</span></li>)}</ul>
      <p className="lu-hint">It can never approve a change, confirm “props removed”, or arm your drone.</p>
    </section>
  );
}

/** Shown when an assistant app sends the person here to allow a connection. */
export function Consent({ id }: { id: string }) {
  const [info, setInfo] = useState<{ client: string; scopes: string[]; redirectHost: string } | null | undefined>();
  const [busy, setBusy] = useState(false);
  if (info === undefined) { setInfo(null); api('GET', `/oauth/${id}`).then(setInfo, () => setInfo({ client: '', scopes: [], redirectHost: '' })); }
  const decide = async (allow: boolean) => { setBusy(true); try { location.href = (await api('POST', `/oauth/${id}`, { allow })).redirect; } catch { setBusy(false); toast('This request has expired. Start again from your assistant.', 'bad'); } };
  if (!info) return <div className="lu-consent" />;
  if (!info.client) return <div className="lu-consent"><div className="lu-consent-card"><h1>Request expired</h1><p>Start again from your assistant.</p><a className="lu-btn" href="/">Open Armable</a></div></div>;
  return (
    <div className="lu-consent">
      <div className="lu-consent-card">
        <h1>Connect {info.client}?</h1>
        <ul>{info.scopes.map(s => { const [Icon, text] = SCOPE[s] ?? [Eye, s]; return <li key={s}><Icon size={18} />{text}</li>; })}</ul>
        <p className="lu-hint">You approve every change to your drone, here in Armable. It returns you to {info.redirectHost}.</p>
        <div className="lu-row"><button className="lu-btn is-primary" disabled={busy} onClick={() => decide(true)}>Allow</button><button className="lu-btn" disabled={busy} onClick={() => decide(false)}>Decline</button></div>
      </div>
    </div>
  );
}

const GRANT_PARTS: PartId[] = ['tuning', 'safety', 'battery', 'receiver', 'gps', 'motors', 'fc', 'osd', 'vtx', 'lights', 'ports'];
const GRANT_TESTS: [string, string, Condition[]][] = [['esc.read', 'Read ESCs', ['propsRemoved', 'directUsb', 'batteryConnected']], ['cal.level', 'Level', ['level', 'still']], ['cal.accel', 'Level', ['level', 'still']], ['fc.restart', 'Restart', []]];
const left = (at: number) => { const m = Math.max(0, Math.round((at - Date.now()) / 60000)); return m < 1 ? '<1 min' : `${m} min`; };

/** Let changes of a chosen kind through without a click, for a while. */
function Permissions() {
  const grants = useStore(s => s.grants), connected = useStore(s => s.snap.status === 'connected'), tests = useStore(s => s.snap.tests);
  const [parts, setParts] = useState<string[]>(['tuning']), [picked, setPicked] = useState<string[]>([]), [minutes, setMinutes] = useState(15), [max, setMax] = useState(10), [confirmed, setConfirmed] = useState<Condition[]>([]);
  const offered = GRANT_TESTS.filter(([id]) => tests.some(t => t.id === id));
  const needs = [...new Set([...offered.filter(([id]) => picked.includes(id)).flatMap(([, , n]) => n), ...(parts.includes('motors') ? ['propsRemoved', 'directUsb'] as Condition[] : [])])];
  const toggle = (list: string[], set: (v: string[]) => void, v: string) => set(list.includes(v) ? list.filter(x => x !== v) : [...list, v]);
  return (
    <>
      <h2 className="lu-sub">Let changes through</h2>
      {grants.length > 0 && <ul className="lu-assistants">{grants.map(g => (
        <li key={g.id}><b>{[...g.parts.map(p => PART_NAME[p as PartId] ?? p), ...g.tests].join(', ')}</b><span>{g.aircraftName} · {g.used}/{g.maxChanges} used · {left(g.expiresAt)} left</span><button className="lu-btn" onClick={() => revokeGrant(g.id)}>Stop</button></li>
      ))}</ul>}
      {!connected ? <p className="lu-hint">Connect the drone to allow changes to it.</p> : (
        <div className="lu-card lu-grant">
          <nav className="lu-chips" aria-label="Parts">{GRANT_PARTS.map(p => <button key={p} className={parts.includes(p) ? 'is-on' : ''} onClick={() => toggle(parts, setParts, p)}>{PART_NAME[p]}</button>)}</nav>
          {offered.length > 0 && <nav className="lu-chips" aria-label="Procedures">{offered.map(([id, label]) => <button key={id} className={picked.includes(id) ? 'is-on' : ''} onClick={() => toggle(picked, setPicked, id)}>{label}</button>)}</nav>}
          <div className="lu-row">
            <label className="lu-tempo">For<select value={minutes} onChange={e => setMinutes(Number(e.target.value))}>{[5, 15, 30, 60].map(m => <option key={m} value={m}>{m} min</option>)}</select></label>
            <label className="lu-tempo">Up to<select value={max} onChange={e => setMax(Number(e.target.value))}>{[3, 10, 25, 50].map(m => <option key={m} value={m}>{m} changes</option>)}</select></label>
          </div>
          <Conditions needs={needs} value={confirmed} onChange={setConfirmed} />
          <button className="lu-btn is-primary" disabled={(!parts.length && !picked.length) || !needs.every(n => confirmed.includes(n))} onClick={() => createGrant({ parts, tests: picked, minutes, maxChanges: max, conditions: confirmed })}>Allow</button>
          <p className="lu-hint">Motor spins and flashing always wait for you.</p>
        </div>
      )}
    </>
  );
}
