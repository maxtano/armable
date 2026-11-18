import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Bot, Check, ChevronDown, Code2, Copy, MessageCircle, MousePointer2, Sparkles, SquareTerminal } from 'lucide-react';
import { api } from './cloud';
import { connectOptions, openBeside, type ConnectOption, type ConnectTarget } from './connectLinks';
import { refreshMe } from './controller';
import { boot } from './Growth';
import { get, toast } from './store';

const ICON: Record<ConnectTarget, typeof Bot> = { claude: Sparkles, chatgpt: MessageCircle, 'claude-code': SquareTerminal, cursor: MousePointer2, vscode: Code2, agents: Bot };
const MAIN: ConnectTarget[] = ['claude', 'chatgpt'];

/** Where assistants connect, as the server knows it (its public address, not necessarily this tab's origin). */
function useAddresses() {
  const [info, setInfo] = useState<{ mcpUrl: string; skillUrl: string } | undefined>();
  useEffect(() => {
    let live = true;
    api('GET', '/connect').then(r => { if (live) setInfo(r); })
      .catch(() => { if (live) setInfo({ mcpUrl: `${location.origin}/mcp`, skillUrl: `${location.origin}/agent-onboarding/SKILL.md` }); });
    return () => { live = false; };
  }, []);
  return info;
}

/**
 * Notice the moment a new assistant connects, by checking every two seconds for ten minutes after the person
 * starts. Sign-in happens in the assistant's window; this tab shares its cookie, so it sees the result too.
 */
function useNewAssistant(watching: boolean, onConnected: (name: string) => void) {
  const done = useRef(onConnected); done.current = onConnected;
  useEffect(() => {
    if (!watching) return;
    let known: Set<string> | undefined, timer: ReturnType<typeof setTimeout>, stopped = false;
    const until = Date.now() + 10 * 60_000;
    const tick = async () => {
      try {
        const me = await api('GET', '/me') as { signedIn?: boolean; assistants?: { clientId: string; name: string }[] };
        const now = me.assistants ?? [];
        if (!known) known = new Set(me.signedIn ? now.map(a => a.clientId) : []);
        else { const fresh = now.find(a => !known!.has(a.clientId)); if (fresh) { done.current(fresh.name); return; } }
      } catch { /* try again */ }
      if (!stopped && Date.now() < until) timer = setTimeout(() => void tick(), 2000);
    };
    void tick();
    return () => { stopped = true; clearTimeout(timer); };
  }, [watching]);
}

/** “Connect your AI”: Claude or ChatGPT in one click, side by side with Armable, and every other agent below. */
export function ConnectMenu({ big, others }: { big?: boolean; /** Everything but Claude, behind a small link: Claude has its own button. */ others?: boolean }) {
  const [open, setOpen] = useState(false), [chosen, setChosen] = useState<ConnectOption>(), [connected, setConnected] = useState<string>();
  const box = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null);
  const addresses = useAddresses();
  const options = (addresses ? connectOptions(addresses.mcpUrl, addresses.skillUrl) : []).filter(o => !others || (o.id !== 'claude' && o.id !== 'chatgpt'));
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); button.current?.focus(); } };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key); };
  }, [open]);
  useNewAssistant(!!chosen && !connected, name => {
    setConnected(name);
    const wasSignedIn = !!get().me?.signedIn;
    toast(`${name} is connected. Say “Start Armable” in a new chat.`, 'ok');
    // Connected from the intro page: the sign-in happened in the assistant's window, so open Armable here too.
    void (wasSignedIn ? refreshMe() : boot());
  });
  const choose = async (option: ConnectOption) => {
    // Windows first, while the click still counts: browsers block windows opened after waiting on anything.
    if (option.href) {
      if (option.beside) { if (!openBeside(option.href)) window.open(option.href, '_blank', 'noopener,noreferrer'); }
      else if (option.href.startsWith('http')) window.open(option.href, '_blank', 'noopener,noreferrer');
      else location.href = option.href;
    }
    await navigator.clipboard?.writeText(option.copy).catch(() => {});
    setConnected(undefined); setChosen(option);
  };
  const item = (option: ConnectOption, main: boolean) => {
    const Icon = ICON[option.id];
    return (
      <button key={option.id} role="menuitem" data-connect={option.id} className={`lu-connect-item${main ? ' is-main' : ''}`} onClick={() => void choose(option)}>
        <span className="lu-connect-icon"><Icon size={main ? 19 : 17} /></span>
        <span className="lu-connect-name">{option.name}{main && <small>{option.id === 'claude' ? 'One click, filled in for you' : 'Paste one address'}</small>}</span>
        {option.href ? <ArrowUpRight size={16} /> : <Copy size={15} />}
      </button>
    );
  };
  return (
    <div className="lu-connect" ref={box}>
      <button ref={button} className={others ? `lu-link lu-connect-link${open ? ' is-open' : ''}` : `lu-btn lu-connect-btn${big ? ' is-big' : ''}${open ? ' is-open' : ''}`} aria-haspopup="menu" aria-expanded={open}
        onClick={() => { setOpen(!open); if (!open && connected) { setChosen(undefined); setConnected(undefined); } }}>
        {!others && <span className="lu-connect-stack" aria-hidden>{(['claude', 'chatgpt', 'cursor'] as const).map(id => { const Icon = ICON[id]; return <span key={id}><Icon size={13} /></span>; })}</span>}
        {others ? 'Use a coding tool' : 'Connect your AI'} <ChevronDown size={15} />
      </button>
      {open && (chosen ? (
        <div className="lu-connect-menu is-guide" role="dialog" aria-label={`Connect ${chosen.name}`}>
          <header><button className="lu-icon" onClick={() => setChosen(undefined)} aria-label="Back"><ArrowLeft size={16} /></button><b>Connect {chosen.name}</b></header>
          <ol className="lu-connect-steps">
            {chosen.steps.map((step, i) => {
              // Every step up to signing in is done once the assistant connects; what follows is next.
              const signIn = chosen.steps.findIndex(s => s.startsWith('Sign in to Armable')), done = !!connected && i <= signIn;
              const state = done ? 'is-done' : connected ? 'is-now' : i === signIn ? 'is-waiting' : '';
              return <li key={i} className={state}><span>{done ? <Check size={13} /> : i + 1}</span>{step}</li>;
            })}
          </ol>
          <p className={`lu-connect-next${connected ? ' is-connected' : ''}`} role="status">{connected ? `${connected} is connected.` : 'Waiting for it to connect…'}</p>
          <div className="lu-row">
            {chosen.href && <button className="lu-btn" onClick={() => void choose(chosen)}><ArrowUpRight size={14} /> Open again</button>}
            <button className="lu-btn" onClick={() => void navigator.clipboard?.writeText(chosen.copy)}><Copy size={14} /> {chosen.id === 'claude-code' ? 'Copy command' : chosen.id === 'agents' ? 'Copy prompt' : 'Copy address'}</button>
          </div>
        </div>
      ) : (
        <div className="lu-connect-menu" role="menu" aria-label="Connect your AI">
          {options.filter(o => MAIN.includes(o.id)).map(o => item(o, true))}
          {options.length > 0 && !others && <span className="lu-connect-other">Coding tools and other agents</span>}
          {options.filter(o => !MAIN.includes(o.id)).map(o => item(o, false))}
          {!addresses && <p className="lu-connect-next">Loading…</p>}
        </div>
      ))}
    </div>
  );
}
