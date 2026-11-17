import { useState } from 'react';
import { Check, Copy, Eye, PencilRuler, Unplug, Wrench } from 'lucide-react';
import { api } from './cloud';
import { refreshMe, setMode } from './controller';
import { toast, useStore, type AssistantMode } from './store';

const TOOLS: [string, string][] = [
  ['get_workspace', 'Where things stand'], ['find', 'Search everything'], ['read', 'Read values'], ['run_test', 'Run a check'], ['propose_change', 'Propose a change'], ['wait', 'Wait for you'],
  ['edit', 'Edit a document'], ['undo', 'Undo its edit'], ['show', 'Point at something'], ['capture_view', 'See the screen'], ['stop', 'Stop'],
];
const SCOPE: Record<string, [typeof Eye, string]> = { observe: [Eye, 'Read your drone'], design: [PencilRuler, 'Edit shows and sounds'], propose: [Wrench, 'Propose changes'] };

export function ModeSwitch() {
  const mode = useStore(s => s.me?.mode ?? 'propose');
  const options: [AssistantMode, string][] = [['off', 'Off'], ['observe', 'Observe'], ['propose', 'Propose']];
  return <div className="lu-segments is-mode" role="radiogroup" aria-label="What assistants may do">{options.map(([value, label]) => <button key={value} role="radio" aria-checked={mode === value} onClick={() => setMode(value)}>{label}</button>)}</div>;
}

/** Connect your own assistant: one address to paste, then sign in. */
export function Connect() {
  const me = useStore(s => s.me), [copied, setCopied] = useState(false);
  const copy = async () => { await navigator.clipboard.writeText(me?.mcpUrl ?? '').catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  const remove = async (clientId: string) => { await api('DELETE', `/assistants/${clientId}`); await refreshMe(); toast('Disconnected', 'info'); };
  return (
    <section className="lu-page is-narrow">
      <header className="lu-page-head"><h1>Your assistant</h1><ModeSwitch /></header>
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
  if (!info.client) return <div className="lu-consent"><div className="lu-consent-card"><h1>Request expired</h1><p>Start again from your assistant.</p><a className="lu-btn" href="/">Open Lucidity</a></div></div>;
  return (
    <div className="lu-consent">
      <div className="lu-consent-card">
        <h1>Connect {info.client}?</h1>
        <ul>{info.scopes.map(s => { const [Icon, text] = SCOPE[s] ?? [Eye, s]; return <li key={s}><Icon size={18} />{text}</li>; })}</ul>
        <p className="lu-hint">You approve every change to your drone, here in Lucidity. It returns you to {info.redirectHost}.</p>
        <div className="lu-row"><button className="lu-btn is-primary" disabled={busy} onClick={() => decide(true)}>Allow</button><button className="lu-btn" disabled={busy} onClick={() => decide(false)}>Decline</button></div>
      </div>
    </div>
  );
}
