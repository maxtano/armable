import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Bot, Check, ChevronDown, Code2, Copy, MessageCircle, MousePointer2, Sparkles, SquareTerminal } from 'lucide-react';
import { api } from './cloud';
import { connectOptions, type ConnectOption, type ConnectTarget } from './connectLinks';

const ICON: Record<ConnectTarget, typeof Bot> = { claude: Sparkles, chatgpt: MessageCircle, 'claude-code': SquareTerminal, cursor: MousePointer2, vscode: Code2, agents: Bot };

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

/** “Connect your AI”: a short menu of assistants, each one click away, plus a prompt that sets up any agent. */
export function ConnectMenu({ big }: { big?: boolean }) {
  const [open, setOpen] = useState(false), [chosen, setChosen] = useState<ConnectOption | undefined>();
  const box = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null);
  const addresses = useAddresses();
  const options = addresses ? connectOptions(addresses.mcpUrl, addresses.skillUrl) : [];
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); button.current?.focus(); } };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key); };
  }, [open]);
  const choose = async (option: ConnectOption) => {
    await navigator.clipboard?.writeText(option.copy).catch(() => {});
    if (option.href) {
      if (option.href.startsWith('http')) window.open(option.href, '_blank', 'noopener,noreferrer');
      else location.href = option.href;
    }
    setChosen(option);
  };
  return (
    <div className="lu-connect" ref={box}>
      <button ref={button} className={`lu-btn lu-connect-btn${big ? ' is-big' : ''}${open ? ' is-open' : ''}`} aria-haspopup="menu" aria-expanded={open}
        onClick={() => { setOpen(!open); setChosen(undefined); }}>
        <span className="lu-connect-stack" aria-hidden>{(['claude', 'chatgpt', 'cursor'] as const).map(id => { const Icon = ICON[id]; return <span key={id}><Icon size={13} /></span>; })}</span>
        Connect your AI <ChevronDown size={15} />
      </button>
      {open && (
        <div className="lu-connect-menu" role="menu" aria-label="Connect your AI">
          {options.map(option => {
            const Icon = ICON[option.id];
            const opens = !!option.href;
            return (
              <button key={option.id} role="menuitem" data-connect={option.id} className={`lu-connect-item${option.id === 'agents' ? ' is-agents' : ''}${chosen?.id === option.id ? ' is-chosen' : ''}`} onClick={() => void choose(option)}>
                <span className="lu-connect-icon"><Icon size={17} /></span>
                <span className="lu-connect-name">{option.name}</span>
                {chosen?.id === option.id ? <Check size={16} /> : opens ? <ArrowUpRight size={16} /> : <Copy size={15} />}
              </button>
            );
          })}
          {chosen && <p className="lu-connect-next" role="status">{chosen.next}</p>}
          {!addresses && <p className="lu-connect-next">Loading…</p>}
        </div>
      )}
    </div>
  );
}
