import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, PanelRight, X } from 'lucide-react';
import { api } from './cloud';
import { claudeChatLink, claudeInstallLink, openBeside } from './connectLinks';
import { go, refreshMe } from './controller';
import { boot } from './Growth';
import { get, set, useStore } from './store';

/**
 * The one way to start: connect Claude, then work side by side.
 *
 *   1. Start with Claude     Claude opens on the left, with Armable filled in. The person clicks Add, then Connect.
 *   2. Allow                 A small Armable window asks “Let Claude use Armable?”. One click; a guest bench if needed.
 *   3. Done                  Armable notices, turns Claude's window into a new chat with “Check my drone” typed, and
 *                            offers to put Armable on the right.
 *
 * Every step is watched rather than trusted: nothing is ticked until Armable sees Claude connected.
 */

export const FIRST_MESSAGE = 'Check my drone in Armable';
let claude: Window | null = null;
const claudeIsOpen = () => !!claude && !claude.closed;
/** Point Claude's window somewhere else. If the browser refuses, the dialog offers a plain link instead. */
function send(url: string) {
  try { claude!.location.href = url; claude!.focus(); } catch { claude = null; }
}

async function addresses() {
  try { return await api('GET', '/connect') as { mcpUrl: string }; } catch { return { mcpUrl: `${location.origin}/mcp` }; }
}

/** Start, or start again. Opens Claude on the left half of the screen; if the browser blocks that, a tab. */
export async function startClaude() {
  // Open the window first, while the click still counts as the person's: browsers block windows opened later.
  claude = openBeside('about:blank', 'left');
  set({ setup: { stage: 'waiting', since: Date.now(), blocked: !claude } });
  const { mcpUrl } = await addresses();
  if (claude) send(claudeInstallLink(mcpUrl));
}

function finish(name: string) {
  const wasSignedIn = !!get().me?.signedIn;
  set({ setup: { stage: 'connected', since: Date.now(), name } });
  // Claude's window becomes a new chat with the first message typed, ready to send.
  if (claudeIsOpen()) send(claudeChatLink(FIRST_MESSAGE));
  // Set up from the intro page: the sign-in happened in Claude's window, so open the bench here too.
  void (wasSignedIn ? refreshMe() : boot());
}

/** Notice a new assistant the moment it connects: every 2 s for 15 minutes. This tab shares the Allow window's cookie. */
function useWatch(active: boolean) {
  useEffect(() => {
    if (!active) return;
    let known: Set<string> | undefined, timer: ReturnType<typeof setTimeout>, stopped = false;
    const until = Date.now() + 15 * 60_000;
    const tick = async () => {
      try {
        const me = await api('GET', '/me') as { signedIn?: boolean; assistants?: { clientId: string; name: string }[] };
        const now = me.assistants ?? [];
        if (!known) known = new Set(me.signedIn ? now.map(a => a.clientId) : []);
        else { const fresh = now.find(a => !known!.has(a.clientId)); if (fresh) { finish(fresh.name); return; } }
      } catch { /* try again */ }
      if (!stopped && Date.now() < until) timer = setTimeout(() => void tick(), 2000);
    };
    void tick();
    return () => { stopped = true; clearTimeout(timer); };
  }, [active]);
}

/** Armable in a window on the right half, beside Claude. This tab then says so, and can take over again. */
function putArmableRight() {
  if (openBeside(location.origin + '/', 'right')) set({ setup: undefined, moved: true });
}

export function ClaudeSetup() {
  const setup = useStore(s => s.setup);
  const [slow, setSlow] = useState(false), [help, setHelp] = useState(false);
  const since = useRef(0);
  useWatch(setup?.stage === 'waiting');
  useEffect(() => {
    if (setup?.stage !== 'waiting') return;
    since.current = setup.since; setSlow(false);
    const t = setTimeout(() => setSlow(true), 40_000);
    return () => clearTimeout(t);
  }, [setup?.stage, setup?.since]);
  if (!setup) return null;
  const close = () => set({ setup: undefined });
  const done = setup.stage === 'connected';
  const steps: [string, string?][] = [
    ['In Claude, click **Add**, then **Connect**.', 'Sign in to Claude first if it asks.'],
    ['In the small Armable window, click **Allow**.'],
    [`In Claude, press **Enter** to send “${FIRST_MESSAGE}”.`],
  ];
  return (
    <div className="lu-scrim cs-scrim" role="dialog" aria-modal aria-label="Connect Claude" onClick={e => e.target === e.currentTarget && done && close()}>
      <div className="lu-dialog cs">
        <header><h2>{done ? `${setup.name ?? 'Claude'} is connected` : 'Connect Claude'}</h2><button className="lu-icon" onClick={close} aria-label="Close"><X size={17} /></button></header>
        <ol className="cs-steps">
          {steps.map(([text, sub], i) => {
            const state = done ? (i < 2 ? 'is-done' : 'is-now') : i === 0 ? 'is-now' : '';
            return (
              <li key={i} className={state} data-step={i + 1}>
                <span>{done && i < 2 ? <Check size={14} /> : i + 1}</span>
                <p>{bold(text)}{sub && !done && <small>{sub}</small>}</p>
              </li>
            );
          })}
        </ol>
        {done ? <>
          <div className="lu-row">
            {claudeIsOpen() ? <button className="lu-btn is-primary" onClick={putArmableRight}><PanelRight size={15} /> Put Armable on the right</button>
              : <a className="lu-btn is-primary" href={claudeChatLink(FIRST_MESSAGE)} target="_blank" rel="noreferrer"><ArrowUpRight size={15} /> Open a new Claude chat</a>}
            <button className="lu-btn" onClick={close}>Stay here</button>
          </div>
          <p className="lu-hint">Claude not using Armable in the chat? Click <b>+</b>, then <b>Connectors</b>, and turn on Armable.</p>
        </> : <>
          <p className="cs-wait" role="status">{setup.blocked ? 'Your browser blocked the Claude window.' : slow ? 'Still waiting. In Claude, click Connect next to Armable.' : 'Waiting for Claude…'}</p>
          <div className="lu-row">
            <button className={`lu-btn${setup.blocked ? ' is-primary' : ''}`} onClick={() => void startClaude()}><ArrowUpRight size={15} /> {setup.blocked ? 'Open Claude' : 'Open Claude again'}</button>
            <button className="lu-link" onClick={() => setHelp(!help)} aria-expanded={help}>Claude won’t add it?</button>
          </div>
          {help && <ul className="cs-help">
            <li>On Claude’s free plan you can add one app like this. Remove another under <b>Customize → Connectors</b>, or upgrade.</li>
            <li>On a work account, only your Claude admin can add apps. Ask them, or use a personal account.</li>
            <li>Use Claude in Chrome or Edge for this step. The Claude desktop app picks it up afterwards.</li>
          </ul>}
        </>}
      </div>
    </div>
  );
}

/** Shown in the tab that handed over to the window on the right. */
export function MovedRight() {
  return (
    <div className="lu-consent">
      <div className="lu-consent-card">
        <h1>Armable is open on the right</h1>
        <p>Claude is on the left. You can close this tab.</p>
        <button className="lu-btn" onClick={() => set({ moved: false })}>Use this tab instead</button>
      </div>
    </div>
  );
}

/** The light in the top bar: green once an assistant is connected, otherwise the way back to setup. */
export function ClaudeLight() {
  const assistants = useStore(s => s.me?.assistants);
  const named = assistants?.find(a => /claude/i.test(a.name)) ?? assistants?.[0];
  if (named) return <button className="cs-light is-on" onClick={() => go('connect')} title="See what it may do, or disconnect"><i />{named.name} connected</button>;
  return <button className="cs-light" onClick={() => void startClaude()}><i />Connect Claude</button>;
}

/** **bold** in step text, nothing else. */
function bold(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/).map((part, i) => part.startsWith('**') ? <b key={i}>{part.slice(2, -2)}</b> : part);
}
