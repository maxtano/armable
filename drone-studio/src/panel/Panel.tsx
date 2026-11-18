import { useEffect, useRef, useState } from 'react';
import { App } from '@modelcontextprotocol/ext-apps/app-with-deps';
import { Diagram } from '../web/Diagram';
import { EMPTY_SNAP, set, useStore, type ProposalCard } from '../web/store';
import type { Setting } from '../device/types';

/**
 * Armable inside the chat. Everything comes from one panel-only tool, read once a second over the assistant's
 * own connection, so there is nothing to sign in to here. Plugging in a real drone happens in an Armable tab,
 * because browsers don't allow USB inside an app's frame.
 */

interface State {
  bench: boolean;
  snapshot?: Record<string, unknown>;
  settings: { id: string; value: unknown }[];
  proposals: { id: string; status: string; part?: string; title: string; changes?: { id: string; value: unknown }[]; test?: { id: string; args?: Record<string, unknown> } }[];
  /** The drone is the server's demo: its changes can be approved right here. */
  cloudDemo: boolean;
  appUrl: string;
}

/** Tell the assistant what the person just did, so it carries on without being asked (where the host allows it). */
function tell(text: string) {
  if (!app.getHostCapabilities()?.message) return;
  void app.sendMessage({ role: 'user', content: [{ type: 'text', text }] }).catch(() => {});
}

const app = new App({ name: 'Armable', version: '1.0.0' }, { availableDisplayModes: ['inline', 'fullscreen'] });

export function Panel() {
  const [state, setState] = useState<State>(), [error, setError] = useState(''), [inline, setInline] = useState(false), [canExpand, setCanExpand] = useState(false), [busy, setBusy] = useState('');
  const snap = useStore(s => s.snap);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return; started.current = true;
    const context = () => {
      const c = app.getHostContext();
      if (c?.theme) document.documentElement.dataset.theme = c.theme;
      setInline(c?.displayMode !== 'fullscreen');
      setCanExpand(!!c?.availableDisplayModes?.includes('fullscreen'));
    };
    app.onhostcontextchanged = context;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await run('armable_panel');
      timer = setTimeout(() => void poll(), document.visibilityState === 'hidden' ? 5000 : 1000);
    };
    void app.connect().then(() => { context(); void poll(); });
    return () => clearTimeout(timer);
  }, []);
  /** Call one of the panel's tools; each answers with what the panel should now show. */
  async function run(name: string, args: Record<string, unknown> = {}) {
    try {
      const result = await app.callServerTool({ name, arguments: args });
      if (result.isError) { setError(errorText(result)); return false; }
      const next = result.structuredContent as unknown as State;
      setError(''); setState(next);
      set({ snap: (next.snapshot as never) ?? EMPTY_SNAP, settings: next.settings as unknown as Setting[], proposals: next.proposals as unknown as ProposalCard[] });
      return true;
    } catch { setError('Armable can’t be reached right now.'); return false; }
  }
  const demo = async () => {
    setBusy('Starting the demo drone…');
    if (await run('armable_demo')) tell('I started the demo drone in Armable. What’s wrong with it?');
    setBusy('');
  };
  const approve = async (id: string, title: string) => {
    setBusy('Approving…');
    if (await run('armable_approve', { proposal: id })) tell(`I approved “${title}” in Armable.`);
    setBusy('');
  };
  const open = (path = '') => void app.openLink({ url: new URL(path, state?.appUrl ?? 'https://app.armable.ai/').href });
  const id = snap.identity, waiting = state?.proposals.filter(p => p.status === 'awaiting_approval') ?? [];
  return (
    <div className={`pn${inline ? ' is-inline' : ''}`}>
      <header className="pn-head">
        <b className="pn-logo">Armable</b>
        <span className={`pn-status${state?.bench ? ' is-on' : ''}`}><i />{state?.bench ? (snap.demo ? `Demo drone · ${id?.firmware ?? ''}` : id?.craftName ?? id?.firmware ?? 'Drone connected') : 'No drone yet'}</span>
        {inline && canExpand && <button className="lu-btn" onClick={() => void app.requestDisplayMode({ mode: 'fullscreen' })}>Open beside the chat</button>}
      </header>
      {error ? <p className="pn-note is-bad">{error}</p> : !state ? <p className="pn-note">Opening Armable…</p> : state.bench ? <>
        <div className="pn-drone"><Diagram /></div>
        {waiting.map(p => (
          <div key={p.id} className="pn-ask">
            <span><b>Waiting for you</b>{p.title}</span>
            {state.cloudDemo ? <button className="lu-btn is-primary" data-panel="approve" disabled={!!busy} onClick={() => void approve(p.id, p.title)}>Approve</button>
              : <button className="lu-btn is-primary" onClick={() => open('/')}>Approve in Armable</button>}
          </div>
        ))}
        {busy && <p className="pn-note" role="status">{busy}</p>}
        {state.cloudDemo && <p className="pn-note">This is the demo drone. <button className="lu-link" onClick={() => void run('armable_demo', { stop: true })}>Stop the demo</button> · <button className="lu-link" onClick={() => open('/')}>Plug in your own drone</button></p>}
      </> : (
        <section className="pn-welcome">
          <h1>Armable is ready</h1>
          <ol><li>You chat on the left.</li><li>Your drone shows here.</li><li>Nothing changes until you approve it.</li></ol>
          <div className="pn-actions">
            <button className="lu-btn is-primary is-big" data-panel="demo" disabled={!!busy} onClick={() => void demo()}>{busy || 'Try the demo drone'}</button>
            <button className="lu-btn is-big" data-panel="plug" onClick={() => open('/')}>Plug in your drone</button>
          </div>
          <p className="pn-note">To plug in a drone, Armable opens in your browser. Use Chrome or Edge, props off.</p>
        </section>
      )}
      <footer className="pn-foot"><button className="lu-link" onClick={() => open('/')}>Open Armable in the browser</button></footer>
    </div>
  );
}

function errorText(result: { content?: { type: string; text?: string }[] }) {
  try { return JSON.parse(result.content?.[0]?.text ?? '{}').error?.message ?? 'Something went wrong.'; } catch { return 'Something went wrong.'; }
}
