import { useEffect, useState } from 'react';
import { ArrowUpRight, Check, Copy, MessageCircle, Monitor, Sparkles, X } from 'lucide-react';
import { api } from '../platform/cloud';
import { chatgptChatLink, claudeAppChatLink, claudeChatLink, claudeInstallLink, openBeside } from './connectLinks';
import { go, refreshMe } from './controller';
import { boot } from './Growth';
import { get, set, useStore } from './store';

/**
 * The one way to start: connect Claude or ChatGPT once, then say “Start Armable” in a new chat.
 *
 *   1. Choose           Claude or ChatGPT. Its window opens on the left; this checklist sits on the right.
 *   2. Connect          Claude: its own “Add” box, filled in. ChatGPT: its settings, with the address copied.
 *   3. Allow            A small Armable window asks “Let Claude use Armable?”. One click; a guest bench if needed.
 *   4. Start Armable    Armable notices by itself, then one button opens a new chat with “Start Armable” typed.
 *
 * Nothing is ticked until Armable sees the assistant connected.
 */

export type Ai = 'claude' | 'chatgpt';
export const FIRST_MESSAGE = 'Start Armable';
const NAME: Record<Ai, string> = { claude: 'Claude', chatgpt: 'ChatGPT' };

/** Where assistants connect. Fetched early, so the address can be copied inside the click that needs it. */
let mcpUrl = `${location.origin}/mcp`;
export const loadAddress = () => api('GET', '/connect').then((r: { mcpUrl: string }) => { mcpUrl = r.mcpUrl; }, () => {});

let assistantWindow: Window | null = null;
const windowOpen = () => !!assistantWindow && !assistantWindow.closed;

/** Ask which assistant, from anywhere (the top-bar light, the assistant page). */
export const chooseAi = () => set({ setup: { stage: 'choose', since: Date.now() } });

/** Start, or start again: the assistant opens on the left half of the screen, already at the right place. */
export function startSetup(ai: Ai) {
  // Everything that needs the click happens first: browsers block windows and clipboard writes made later.
  const url = ai === 'claude' ? claudeInstallLink(mcpUrl) : 'https://chatgpt.com/#settings/Connectors';
  assistantWindow = openBeside(url, 'left');
  if (ai === 'chatgpt') void navigator.clipboard?.writeText(mcpUrl).catch(() => {});
  set({ setup: { ai, stage: 'waiting', since: Date.now(), blocked: !assistantWindow } });
}

function connected(name: string) {
  const wasSignedIn = !!get().me?.signedIn;
  set({ setup: { ...get().setup!, stage: 'connected', since: Date.now(), name } });
  // Set up from the intro page: the sign-in happened in the assistant's window, so open the bench here too.
  void (wasSignedIn ? refreshMe() : boot());
}

/** The last click: a new chat with “Start Armable” typed, in a normal tab. The setup window goes away. */
function openChat(ai: Ai, app = false) {
  if (windowOpen()) assistantWindow!.close();
  assistantWindow = null;
  if (app) location.href = claudeAppChatLink(FIRST_MESSAGE);
  else window.open(ai === 'claude' ? claudeChatLink(FIRST_MESSAGE) : chatgptChatLink(FIRST_MESSAGE), '_blank', 'noopener,noreferrer');
  set({ setup: undefined });
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
        else { const fresh = now.find(a => !known!.has(a.clientId)); if (fresh) { connected(fresh.name); return; } }
      } catch { /* try again */ }
      if (!stopped && Date.now() < until) timer = setTimeout(() => void tick(), 2000);
    };
    void tick();
    return () => { stopped = true; clearTimeout(timer); };
  }, [active]);
}

const STEPS: Record<Ai, [string, string?][]> = {
  claude: [
    ['In Claude’s box, click **Continue**, then **Add**.', 'Sign in to Claude first if it asks. Armable is already filled in.'],
    ['Click **Connect** next to Armable.'],
    ['In the small Armable window, click **Allow**.'],
  ],
  chatgpt: [
    ['In ChatGPT, open **Apps & Connectors**, then **Advanced settings**, and turn on **Developer mode**.', 'Only the first time. Needs ChatGPT Plus or Pro.'],
    ['Click **Create**. Name it **Armable**, paste the address (it’s copied), choose **OAuth**, tick **I trust this application**, then **Create**.'],
    ['In the small Armable window, click **Allow**.'],
  ],
};

export function ClaudeSetup() {
  const setup = useStore(s => s.setup);
  const [slow, setSlow] = useState(false), [help, setHelp] = useState(false);
  useEffect(() => { void loadAddress(); }, []);
  useWatch(setup?.stage === 'waiting');
  useEffect(() => {
    setSlow(false); setHelp(false);
    if (setup?.stage !== 'waiting') return;
    const t = setTimeout(() => setSlow(true), 45_000);
    return () => clearTimeout(t);
  }, [setup?.stage, setup?.since]);
  if (!setup) return null;
  const close = () => set({ setup: undefined });
  if (setup.stage === 'choose' || !setup.ai) return (
    <div className="lu-scrim cs-scrim" role="dialog" aria-modal aria-label="Connect your AI" onClick={e => e.target === e.currentTarget && close()}>
      <div className="lu-dialog cs">
        <header><h2>Which AI do you use?</h2><button className="lu-icon" onClick={close} aria-label="Close"><X size={17} /></button></header>
        <AiButtons />
        <p className="lu-hint">Connect once. Then say <b>“{FIRST_MESSAGE}”</b> in any new chat.</p>
      </div>
    </div>
  );
  const ai = setup.ai, name = NAME[ai], done = setup.stage === 'connected';
  return (
    <div className="lu-scrim cs-scrim is-side" role="dialog" aria-modal aria-label={`Connect ${name}`}>
      <div className="lu-dialog cs">
        <header><h2>{done ? `${setup.name ?? name} is connected` : `Connect ${name}`}</h2><button className="lu-icon" onClick={close} aria-label="Close"><X size={17} /></button></header>
        <ol className="cs-steps">
          {STEPS[ai].map(([text, sub], i) => (
            <li key={i} className={done ? 'is-done' : 'is-now'} data-step={i + 1}>
              <span>{done ? <Check size={14} /> : i + 1}</span>
              <p>{bold(text)}{sub && !done && <small>{sub}</small>}</p>
            </li>
          ))}
          <li className={done ? 'is-now is-last' : 'is-last'} data-step={4}>
            <span>4</span>
            <p>{bold(`Open a new chat and send **“${FIRST_MESSAGE}”**.`)}{!done && <small>Armable opens it for you, with the words typed in.</small>}</p>
          </li>
        </ol>
        {done ? <>
          <div className="cs-actions">
            <button className="lu-btn is-primary is-big" data-open-chat onClick={() => openChat(ai)}><ArrowUpRight size={17} /> Open {name}</button>
            {ai === 'claude' && <button className="lu-link" onClick={() => openChat(ai, true)}><Monitor size={14} /> Open the Claude app instead</button>}
          </div>
          <p className="lu-hint">{ai === 'claude' ? <>Claude not using Armable? In the chat, click <b>+</b>, then <b>Connectors</b>, and turn on Armable.</> : <>ChatGPT not using Armable? In the chat, click <b>+</b>, then <b>Developer mode</b>, and turn on Armable.</>}</p>
        </> : <>
          <p className="cs-wait" role="status">{setup.blocked ? `Your browser blocked the ${name} window.` : slow ? (ai === 'claude' ? 'Still waiting. In Claude, click Connect next to Armable.' : 'Still waiting. In ChatGPT, finish Create, then click Allow.') : 'Waiting for you…'}</p>
          <div className="lu-row">
            <button className={`lu-btn${setup.blocked ? ' is-primary' : ''}`} onClick={() => startSetup(ai)}><ArrowUpRight size={15} /> {setup.blocked ? `Open ${name}` : `Open ${name} again`}</button>
            {ai === 'chatgpt' && <button className="lu-btn" onClick={() => void navigator.clipboard?.writeText(mcpUrl)}><Copy size={14} /> Copy the address</button>}
            <button className="lu-link" onClick={() => setHelp(!help)} aria-expanded={help}>Stuck?</button>
          </div>
          {help && <ul className="cs-help">{ai === 'claude' ? <>
            <li>On Claude’s free plan you can add one app like this. Remove another under <b>Customize → Connectors</b>, or upgrade.</li>
            <li>On a work account, only your Claude admin can add apps. Ask them, or use a personal account.</li>
            <li>Use the same Claude account here as in your Claude app.</li>
          </> : <>
            <li>Developer mode needs ChatGPT Plus or Pro. On a work account, your admin may need to allow it.</li>
            <li>The address to paste is <code>{mcpUrl}</code></li>
            <li>Rather use Claude? <button className="lu-link" onClick={() => startSetup('claude')}>Connect Claude instead</button></li>
          </>}</ul>}
        </>}
      </div>
    </div>
  );
}

/** Claude or ChatGPT: the only choice anyone makes. */
export function AiButtons({ big }: { big?: boolean }) {
  return (
    <div className="cs-ais">
      <button className={`lu-btn is-primary${big ? ' is-big' : ''}`} data-start="claude" onClick={() => startSetup('claude')}><Sparkles size={18} /> Claude</button>
      <button className={`lu-btn is-primary${big ? ' is-big' : ''}`} data-start="chatgpt" onClick={() => startSetup('chatgpt')}><MessageCircle size={18} /> ChatGPT</button>
    </div>
  );
}

/** The light in the top bar: green once an assistant is connected, otherwise the way back to setup. */
export function ClaudeLight() {
  const assistants = useStore(s => s.me?.assistants);
  const named = assistants?.[0];
  if (named) return <button className="cs-light is-on" onClick={() => go('connect')} title={`Say “${FIRST_MESSAGE}” in a new chat`}><i />{named.name} connected</button>;
  return <button className="cs-light" onClick={chooseAi}><i />Connect your AI</button>;
}

/** **bold** in step text, nothing else. */
function bold(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/).map((part, i) => part.startsWith('**') ? <b key={i}>{part.slice(2, -2)}</b> : part);
}
